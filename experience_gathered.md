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

- **Implicit identity (`X id`)**: declaring `aggregate Order` is enough;
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
`record Money { decimal Amount, string Currency }` doesn't run a body block
on `new Money { ... }` — only on `new Money {}`.  Use **explicit
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
`X id` record-structs and value-object types into the wire format and
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

### Test DSL: assertions are method-based (`expect(x).toThrow()`)
Originally throws were a `expectThrows <expression>` statement keyword.  That
was later unified into the method-matcher surface every other assertion uses:
`expect(<call>).toThrow()` (optionally `.toThrow(<status>)` for an e2e HTTP
status).  A bare `expect <bool>` is likewise rejected — every `expect` carries
a matcher.  The key implementation trick: the *surface* is method-based, but
`toThrow` is recognised in **lowering** and rewritten into the existing
`expect-throws` IR node, so no backend renderer changed (a throw still needs
structurally different codegen than a value matcher — lambda-wrapping /
`rejects` / `Assert.Throws` — which is exactly why it keeps a dedicated IR node
while value matchers ride a flag on a `method-call`).  Matchers are a closed
catalogue (`src/util/intrinsic-matchers.ts`); they're type-check-exempt
(`checkUnknownMemberAccess` skips them, so `expect(Money{…}).toThrow()` is legal
even though `toThrow` is not a member of `Money`).

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
  legal.  *Partially landed:* the membership form
  `this.<refColl>.contains(param)` over an `T id[]` reference
  collection is now queryable (see the join-table note below) —
  it lowers to `inArray(root.id, SELECT ownerFk FROM joinTable
  WHERE targetFk = param)`.  The general containment-count case
  is still deferred.
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
  `DddScopeComputation.collectExportedSymbols` (`qualifiedNameOf` walks
  containers up to, but excluding, the enclosing `system`).  The default
  scope provider then resolves the dotted reference text against those
  exports — no custom `getScope` branch needed.  Lowering reads the
  `kind` off the resolved node's `$type` and the qualified name off
  `ref.$refText`, so backends never re-resolve.
- **The docs are a derived view, like the Mermaid diagrams.**  They live
  in `src/system/traceability.ts`, are emitted once at the output root
  (model-global), and read only the precomputed `TraceabilityIR` from
  `enrichLoomModel` — never recomputing coverage.

## Aggregate factory typing (`X.create(...)`)

- `inferExprType` must special-case `X.create(...)` → `entity X`.  `X` is a
  *type name*, not a value, so `resolveNameRef` returns `unknown` and a
  `let o = Order.create({...})` binding would otherwise type as the string
  fallback.  Operation calls (`o.confirm()`) still render structurally so the
  bug was invisible there — but `o.lines.count` needs `o.lines` to be an
  `array` for the renderer to lower `.count` → `.length` (TS) / `.Count`
  (.NET).  Without the fix it emitted a literal `.count`: a TS type error and
  a runtime `undefined`.  Repro lives in `test/generator-ts.test.ts`
  ("lowers collection `.count` on a let-bound aggregate to `.length`").

## Reference-collection join tables (`field: T id[]`)

- **A collection of references is a different beast from a containment.**
  `contains lines: OrderLine[]` is parts that live and die with the parent
  (child table, `parent_id` FK).  `party: Pokemon id[]` is a set of
  references to *another aggregate* that outlives any one parent — so it
  lowers to a **many-to-many join table**, not a child table.  The
  distinction is already in the IR: containments are `ContainmentIR`,
  reference collections are a `FieldIR` whose type is
  `{kind:"array", element:{kind:"id", targetName}}`.
- **Derive the association once, in enrichment.**  `enrichAggregate`
  populates `agg.associations` (join-table name, owner/target FK column
  names, snake-cased) the same way it populates `wireShape`.  Every
  emitter reads that — schema, repository load, repository save, query
  lowering — so nothing re-derives FK names.  `joinTable =
  snake(owner)_snake(field)` (not `_target`) so two fields pointing at the
  same aggregate (`party` + `caught` → `trainer_party`, `trainer_caught`)
  don't collide.  Self-reference (`Self id[]`) collapses both FKs to one
  name — disambiguate to `owner_id`/`target_id`.
- **Persistence mirrors the containment diff-sync exactly.**  Save selects
  existing target ids for the owner, deletes the removed pairs, then
  `insert(...).onConflictDoNothing()` the current set (composite PK
  `(owner_fk, target_fk)` makes that idempotent).  Load batches the join
  rows into a `Map<ownerId, targetId[]>` and brands them back to
  `Ids.<Target>Id`.
- **The contract is set semantics; ordinal is implementation detail.**
  An earlier iteration of this work pitched `X id[]` as an ordered list
  and added an `ordinal` column to preserve `party[0]` across a
  round-trip.  TS/Drizzle and .NET/EF honour ordinal (write per-row on
  `+=`, `ORDER BY ordinal` on load); Phoenix/Ash leaves the column at
  its default because `Ash.Changeset.manage_relationship` doesn't
  inject join-row attributes.  Three backends, three different ordering
  guarantees — a false promise on the cross-backend contract.  Pulled
  back: a relational join table is naturally a set (composite
  `(owner_fk, target_fk)` PK enforces "each pair appears once"), and
  *that* is what `X id[]` now contractually means.  The ordinal column
  stays on TS/.NET (harmless, gives stable iteration order on those
  backends as a byproduct) and is nullable+defaulted on Phoenix.  When
  position genuinely belongs to the domain — battle slots, draft picks
  — model it as an explicit ordinal field on a dedicated child
  aggregate, not on a `X id[]` field.  Lesson: don't let the natural
  ordering of one backend become an accidental contract.
  - **Update (assoc-join ordinal dropped entirely):** the "harmless on
    TS/.NET" ordinal was later **removed from every backend's `X id[]`
    association join** (schema/migration column, write stamp, and read
    `ORDER BY ordinal`). The only thing it bought was a deterministic
    read-back order, and `ORDER BY <target_fk>` gives the same without a
    column or stamp — content-addressed (backends agree even across
    out-of-order/partial writes) and without falsely implying insertion
    order matters. All five backends now read the join `ORDER BY` the
    **target FK id** (Elixir via `many_to_many preload_order: [asc: :id]`).
    PR #1580 (Elixir insertion-order) was closed won't-do for the same
    reason; DEBT-13 is de-scoped. **Value-object collections keep their
    `ordinal`** — there it's part of the `(parent_id, ordinal)` PK and the
    only way to store an ordered, identity-less list. See
    `docs/proposals/reference-collection-set-semantics.md`.
- **Only `primaryKey` import is conditional.**  Adding `primaryKey` to the
  Drizzle import line unconditionally drifted every existing schema's
  byte-for-byte fixture.  Gate the import on "context has ≥1 join table"
  to keep unaffected schemas identical — the baseline fixtures are a
  tripwire worth respecting.
- **`(__a: never)` in `toWire`'s array branch was latent debt.**  No prior
  example had a populated plain-array property, so the array projection
  path was never type-checked.  The first reference collection through
  `repository.toWire` exposed it (`PokemonId[]` not assignable to
  `(__a: never) =>`).  Dropping the annotation lets `.map` contextually
  type the param.  Reinforces the "always type-check the generated
  output" rule — and that `as never`-style placeholders are debt that
  bites the moment a new shape reaches them.

## Multi-file `.ddd` source (Stage A)

- **File splitting and the visibility model are orthogonal.**  The
  ergonomic ask was "split the file into many"; that's pure plumbing
  (workspace loader, transitive `import`, langium's global index does
  the rest).  The *interesting* design conversation — what crosses a
  context boundary, how DDD context-mapping maps onto syntax — is a
  separate axis we deliberately deferred to Stage B+ to avoid
  conflating them.  The biggest design lesson before code: name the
  axes and ship them separately.
- **`packaging-split.md` already existed — for a different "packaging".**
  That doc is about distributing the toolchain as npm packages
  (`@loom/core` + per-backend packages); the new feature is about
  source-file packaging.  Used `docs/multi-file-source.md` to avoid
  collision; first thing anyone touching either should do is grep both
  files so the topics don't bleed into each other.
- **The export-side scope was already half-wired.**
  `DddScopeComputation.collectExportedSymbols` already exports every named
  declaration (aggregates / VOs / enums / entity parts) via
  `streamAllContents` — the only reason cross-document refs didn't
  resolve before is that the CLI only loaded *one* document.  Once
  the project loader registers every reachable document, Langium's
  default global scope provider resolves cross-doc refs for free.  No
  scope code had to change for Stage A.
- **Per-document lower + merge beats synthesizing a fake Model.**
  Considered concatenating every loaded document's `Model.members`
  into a synthetic top-level `Model`; rejected because every member's
  `$container` would still point at its original document, and
  anything walking upward to find "its Model" would see a different
  node than the one being passed around.  Per-document `lowerModel`
  + a trivial `mergeLoomModels` keeps each IR node anchored to a real
  source document and the merge is just an in-order union of the
  top-level slices.  Single-document callers stay on the same path,
  unchanged.
- **Inject root VOs / enums in `enrichLoomModel`, not at emit time.**
  Picked the enrichment layer for the root-level shared-kernel
  injection because it's already the "compute derived fields" pass
  (`wireShape`, auto-`findAll`, react `moduleNames`).  Folding root
  VOs / enums into every context's effective list at enrichment time
  means backends are completely untouched — they keep iterating
  `ctx.valueObjects` and `ctx.enums` as before.  Output duplicates
  root types across contexts inside a deployable (Money in both
  `products/value-objects.ts` and `orders/value-objects.ts`); a
  future stage may centralise emission per deployable when the
  duplication actually starts hurting.
- **Acceptance test: byte-identical regression on a real example.**
  The gating test for Stage A wraps `examples/acme.ddd` and
  `examples/provenance.ddd` in a trivial `main.ddd` that just
  imports the original file, then diffs the file map against the
  single-file path.  If the multi-file path adds, drops, or perturbs
  even one byte for a project that has zero root-level types, the
  test fails — which is exactly the regression we want gated.
- **CLI: only `generate system` does the workspace walk.**  Legacy
  `generate ts` / `generate dotnet` stay on `parseFile` for one
  reason: they don't compose multi-file output (they emit a single
  project from a single context), so the workspace mechanics would
  add error surface without buying anything.  Keep the seam at the
  one subcommand whose output model is "many things composed."
- **`money` is additive to `decimal`, not a migration.**  `decimal`'s
  JSON-number wire was a JS-friendly compromise that all original
  backends (TS/Hono, .NET, Phoenix, React) silently tolerated.  Adding
  a precise-decimal backend (Rust) forced the wire decision; rather
  than migrating `decimal` to string-on-wire (which would have cost
  an arithmetic-site rewrite in every TS/React generated project), a
  new `money` primitive was introduced — string-on-wire (OpenAPI
  `{type: string, format: decimal}`, the PayPal/Coinbase/ISO 20022
  convention), closed arithmetic (`money ± money = money`, scaling
  by int/long/decimal preserves money, anything else rejected), and
  a constructor literal `money("…")` (Rust-friendly: every host
  Decimal parses from string).  Existing `.ddd` source files don't
  change.  Three design decisions worth their own bullet:
  * **Binary IR carries `leftType` / `resultType`.**  Backends today
    re-derive operand types from operator heuristics; money
    arithmetic (TS `.plus()`, Phoenix `Decimal.add/2`) can't be
    emitted without operand-type information.  Threading the types
    through the binary node at lowering time lets every backend —
    current and future — emit money-aware code without re-running
    inference.
  * **Phoenix `Decimal.compare/2` isn't a token swap.**  Elixir's
    Decimal comparison returns `:lt | :eq | :gt`, not a boolean — so
    `${l} ${op} ${r}` doesn't fit and the renderer needs an
    expression-shape branch for money operands (`Decimal.compare(a,
    b) == :gt` for `>`, `in [:lt, :eq]` for `<=`).
  * **Money invariants run server-side only.**  Client-side JS can't
    compare `Decimal` instances faithfully via host operators; both
    the single-field-chain absorption (`.min(N)`) and the `.refine`
    fallback would emit broken predicates.  The
    `classifyForWire` gate rejects any expression with a money
    literal or money-typed binary operand, leaving the aggregate's
    server-side `_assertInvariants` (which renders via `.gte()` /
    `.lte()`) as the sole enforcement.
- **Adding a new primitive type — the checklist.**  `PrimitiveName`
  + `PRIMITIVES` live in **one place**: `src/ir/loom-ir.ts`.  Every
  other layer (the type-system at `src/language/type-system.ts`, the
  playground field-builder at `web/src/builder/system/fields.ts`)
  re-exports / imports from there — adding the primitive in the IR
  surfaces it in every consumer automatically.  Then in order:
  1. `src/language/ddd.langium` — add the literal to the
     `PrimitiveType` rule's union.
  2. `src/ir/loom-ir.ts` — append to `PrimitiveName` AND to
     `PRIMITIVES` (the array's order is the playground type-picker's
     display order; keep related primitives adjacent).
  3. `npm run langium:generate` — the AST regenerates with the new
     literal in `PrimitiveType.name`'s union.
  4. `tsc -b` from the repo root — every non-exhaustive switch over
     `PrimitiveName` errors with "Fallthrough case in switch" or "Type
     'X' is not assignable to type 'PrimitiveName'."  Those errors
     are the checklist: wire spec (`src/system/wire-spec.ts`'s
     `jsonPropertyForType`), each backend's render-expr /
     dto-mapping / column-type emitter, the Drizzle schema, every
     Zod-for-type switch in routes/views/workflows builders, the
     React form-fields preparer, the macro-api factories union.
  5. Per-backend literal + arithmetic rendering — `render-expr.ts`'s
     `renderLiteral` / `renderBinary` / `renderTsType` (or the
     `.NET` / Phoenix equivalents).  If the new primitive needs
     operator dispatch beyond what native operators give the host
     language (the way `money` needed `Decimal.compare/2` on
     Phoenix), the binary-IR's `leftType` stash is the channel — see
     the `money` entry above.
  6. Tests — parsing + IR lowering coverage under `test/language/` and
     `test/ir/`; per-backend snapshot under `test/generator/`.
  The trap that bit us first time: when a primitive was added but its
  union wasn't synced to the playground's local copy, CI broke at
  `playground-e2e.yml`'s `tsc -b` step (see #499).  Sourcing both
  from `src/ir/loom-ir.ts` removes the failure mode entirely — the
  playground's type picker now picks up new primitives without an
  additional code change.

- Two string forms, not one: `derived display` vs `derived inspect`.

  The original `display` was a property-suffix annotation
  (`name: string display`) consumed only by the React form layer.
  Stretching it to cover "what `string(aggregate)` should render"
  surfaced a hidden conflation: UI labels ("John Smith", short,
  pretty, sensitive-aware) and developer-facing debug forms
  ("User(id: 42, ssn: <redacted>)", structural, includes
  IDs) are different concerns with different audiences.  Every
  mature stdlib already separates them (Ruby `to_s` vs `inspect`,
  Elixir `String.Chars` vs `Inspect`, Python `__str__` vs
  `__repr__`); Loom had one annotation pretending to be both.

  Resolution: two reserved-name derived clauses on aggregates.
  - `derived display: string = ...` — opt-in.  Anchors
    `string(aggregate)` and implicit `"x " + aggregate` (lowering
    rewrites both to `aggregate.display` member access).  Without
    it, both expressions are compile errors — forces an explicit
    decision rather than silent stringification.
  - `derived inspect: string = ...` — auto-synthesized at IR
    enrichment time when omitted.  Structural shape; `sensitive(...)`
    fields render as `<redacted>` literals; VO / array / entity
    fields use `[Type]` placeholders (calling host-language
    `.ToString()` on a VO surfaces the namespace-qualified type
    name, rarely useful).  Backends emit it as `ToString()` (.NET),
    `toString()` + `[util.inspect.custom]` (TS), `defimpl Inspect`
    (Phoenix).  Wire-shape excludes it — internal structure must
    not leak to JSON DTOs.

  Two never collide because they're reached via different call
  paths: `display` only via explicit Loom paths (`string(x)`,
  implicit `+`, UI walker); `inspect` only via host-language debug
  hooks (`Console.WriteLine`, exception messages, IEx, Serilog
  destructuring).  A .NET developer who writes `$"{user}"` gets the
  inspect form (debug-shaped), never accidentally the display form
  (UI-shaped).

  Reserved-name precedent: a property literally named `id` IS the
  aggregate identifier — no annotation, just convention.  `display`
  and `inspect` follow that pattern.  No new grammar primitive;
  `derived <name>: <type> = <expr>` already exists.

  Synthesis lives in `src/ir/enrichments.ts:synthesizeInspect`
  rather than as a stdlib macro.  Two reasons: (a) the macro
  factory layer has no binary-expression / convert-expression
  factories, so a macro implementation would have needed three
  new factories before producing a single inspect; (b) sensitivity
  metadata + wire-shape ordering are both already available at the
  IR layer, so building the expression directly in IR matched the
  surrounding code style.  If a future requirement asks for
  user-replaceable defaults (`derived inspect: string =
  defaultInspectButSkipPii()`), promoting to a macro is mechanical.

  The trap that bit us during implementation: idempotency.
  `enrich(enrich(m))` must equal `enrich(m)`.  First implementation
  added the synthesized inspect to `agg.derived` AFTER computing
  `wireShape`, so the second enrichment saw a longer `derived`
  list and produced a longer wireShape.  Fix: compute the
  post-synthesis aggregate first, then derive wireShape from it
  (`aggWithDerived` local).  Also: filter `inspect` out of the
  wire-fields loop so even user-written `derived inspect` doesn't
  leak to DTOs.

## Cross-generator conformance harness (parity follow-ups)

The 3-way OpenAPI parity test (`test/e2e/e2e.test.ts`,
`test/_helpers/openapi-normalize.ts`) landed in #401 as REPORT-ONLY:
each Phoenix↔Hono / Phoenix↔.NET / Hono↔.NET diff was logged but the
job stayed green.  Closing the showcase divergences took four
sequenced PRs (A → D) plus three side fixes; each surfaced a category
of footgun worth documenting.

- **Layered failures stay hidden behind earlier blockers.**
  PR #524 hard-broke the `Property` grammar's `display` modifier but
  missed migrating `examples/showcase.ddd` (added 12 min earlier in
  #401) and an inline fixture in `elixir-ash-build.yml`.  Both files
  parsed-error at `node bin/cli.js generate`, so every downstream
  failure was invisible.  Fix in #529 + #541.  Lesson: a hard grammar
  break needs a corpus sweep, not just an "in-tree fixtures
  migrated" claim.  Cheap mitigation: run `bin/cli.js parse <file>`
  across every `.ddd` in the repo (incl. workflow inline heredocs)
  in the same commit that changes a Property production.

- **`mix compile --warnings-as-errors` makes every warning a release
  gate.**  Once #541 unblocked the parse step, the Phoenix
  workflow's strict-mode compile surfaced two real warnings that
  blocked every PR touching the generator:

  1. `Igniter.Inflex.{pluralize,singularize}/1` + `Owl.IO.input/1`
     undefined.  `ash_postgres`'s `lib/resource_generator/spec.ex`
     references these at compile time; they're optional deps for
     `mix ash_postgres.gen.resources` and don't get pulled by
     `mix deps.get --only prod`.  Fix in #546: declare them in the
     generated `mix.exs` with `runtime: false` — resolves the
     references without inflating the application start sequence.

  2. `redefining module Inspect.<App>.<Ctx>.<Agg>`.  PR #537 emitted
     a `defimpl Inspect, for: <Module>` after each resource's
     `defmodule` close to render the synthesised `derived inspect`
     body.  `use Ash.Resource` already emits an `Inspect` impl for
     the resource struct; the two collide at compile time.  The
     final fix routes the expression body through a public
     `def inspect(record)` **module function** on the resource
     (`MyApp.Catalog.Customer.inspect/1`) rather than the Inspect
     protocol — different namespace, same body, no collision.  IEx
     / Logger keep Ash's struct Inspect output; callers wanting the
     custom string invoke `<Mod>.inspect(record)` explicitly (the
     same call shape .NET's `ToString()` / TS's `toString()` use).

  Lesson on protocols: when adding an explicit `defimpl Protocol,
  for: <Struct>` to a struct produced by a macro you don't control,
  test against `--warnings-as-errors` BEFORE committing to that
  protocol surface.  Picking a NON-protocol channel (here: a regular
  module function) when the macro-controlled struct owns the
  protocol slot sidesteps the entire collision class.

- **Don't name a *generated* temp var with a leading underscore if the
  body reads it.**  Porting the TS/.NET provenance capture (DEBT-06,
  vanilla foundation) I emitted `__lin_N` / `__prov_inputs_N` temps —
  fine in JS/C#, but in Elixir a leading `_` means "intentionally
  unused", so `--warnings-as-errors` rejects *"the underscored variable
  `__lin_1` is used after being set"*.  Unit string-assertions and
  `tsc` never see it — only the docker `mix compile` gate does.  Fix:
  prefix generated locals that ARE read with a real name (`loom_lineage_N`,
  not `__lineage_N`); reserve the underscore for genuinely-discarded
  bindings (`_ = expr`).  General rule for Elixir codegen: the
  underscore is a *use* assertion, not just a naming convention.

- **Plug router syntax (`:id`) vs OpenAPI path-template syntax
  (`{id}`) are different.**  The OpenApiSpex emitter happily renders
  `"/<plural>/:id"` as a path key — valid Elixir, invalid OpenAPI 3.
  Hono and .NET both emit `{id}`, so the parity harness reports a
  full set of "ops only on phoenix" / "ops missing on phoenix"
  even though the same operation exists on both sides.  Fix in #540:
  use `{id}` in the OpenAPI spec, keep `:id` in `router.ex`.
  Lesson: an OpenAPI emitter is documenting an HTTP contract, not
  the router's internal pattern — the two namespaces happen to
  overlap visually but follow different rules.

- **Runtime wire shape ≠ OpenAPI spec property names.**  PR C
  (#544) added a per-resource `defimpl Jason.Encoder` that camelizes
  atom keys at runtime — `created_at` → `createdAt` on the wire.
  But `openapi-emit.ts` still snake-cased property names in the
  spec, advertising `created_at` to clients while the response said
  `createdAt`.  Strict parity caught it as a field-set drift.
  Fix in C's follow-up commit: emit the source-level (camelCase)
  identifier as the OpenApiSpex property key.  Lesson: when two
  emitters describe the same wire — one declarative (spec) and one
  imperative (runtime) — they need to share the casing decision,
  not converge accidentally.

- **`/ready` is contract from .NET's POV, infrastructure from
  Hono's.**  .NET's `app.MapGet("/ready", ...)` auto-registers the
  endpoint in the OpenAPI document; Hono's `app.get(...)` skips
  registration entirely (no `app.openapi(createRoute(...))`).
  Same backend behaviour at runtime, different doc surface.  The
  harness's `isInfraPath` filter excluded `/health` but not
  `/ready`, so strict mode tripped on a benign divergence.  Fix in
  D (#547): `/ready` joins `/health` in the infra filter.  Lesson:
  the normalisation helper is the right place to encode "what's
  PART of the contract" — the per-backend emitters shouldn't have
  to coordinate on which endpoints to suppress from their specs.

- **The 4-PR cadence (A → B → C → D) paid off.**  Each PR closed
  one diff category in REPORT-ONLY mode; the D flip to
  `LOOM_E2E_STRICT_PARITY=1` waited until the diff list was
  literally empty across the showcase.  Sequencing rationale:
  every intermediate PR has to keep the parity job green (in
  report mode it always is), so the gate flip becomes a one-line
  YAML change instead of a coordinated multi-PR merge.  Same
  pattern works for any "log it now, gate it later" rollout —
  the report-only phase doubles as a regression baseline.

## Substrate cleanup retro (W0 → W4, PRs #557 → #638)

The "substrate-cleanup" series ran roughly Apr→May 2026: thirteen PRs
(W0-A through W4 plus follow-ups #628 and #638) tightening IR brands,
splitting the validator, promoting a walker SSOT, killing legacy
fallback paths, and centralising AST construction. Lessons:

- **Brand the architectural boundary, not every internal call site.**
  W1B-A introduced `EnrichedLoomModel` / `EnrichedAggregateIR` / ... to
  make `wireShape` / `associations` non-optional post-enrichment. The
  initial cascade stopped at `PlatformSurface.emitProject(contexts:
  BoundedContextIR[])` with local `as Enriched...` casts at the eight
  consumer sites. A first cross-cutting audit flagged the local casts;
  fixing them surfaced a deeper pattern (the W3-followups agent counted
  ~224 typed sites that flow raw IR if you push the brand all the way
  down through every helper). The pragmatic resolution (PRs #615, #628)
  was: brand the public surface (`emitProject`), tighten the
  per-platform entry points + per-aggregate helpers that get called
  directly from it, then accept the brand stops at internal utilities.
  Lesson: a brand is most useful at contracts between layers (`system/`
  ↔ `platform/`, `ir/` ↔ `generator/`); pushing it further is
  high-effort and low-marginal-value.

- **Type casts mask latent bugs as often as they silence type errors.**
  Twice during this work, replacing an `as unknown as X` cast with a
  typed builder surfaced a real bug. (a) `BoolLit.value` in
  `ui-factories.ts` is `'true' | 'false'` literal-union, not arbitrary
  string; the cast accepted `String(value)` which would have produced
  invalid AST literals on edge inputs. (b) `web/src/builder/system/
  fields.ts` was setting `display: false` on a `Property` AST node;
  `Property` has no `display` field — the cast accepted it, the runtime
  wrote a property no consumer read. Both bugs were latent for as long
  as the casts existed. Lesson: every `as unknown as X` in
  AST-construction code is a place where the compiler stopped
  type-checking the literal; assume there's drift and verify when you
  migrate.

- **Carve validators by INVARIANT, not by AST type.** W1B-B split the
  monolithic `ddd-validator.ts` into `src/language/validators/<theme>.ts`
  (`deployable.ts`, `aggregate.ts`, `page.ts`, etc.) rather than by the
  node the check fires on. Themes track domain concerns
  (cross-aggregate references, deployable rules, page metamodel);
  organising by AST type would fragment those concerns across files —
  the "cross-aggregate ref" rule and the "containment ref" rule both
  fire on different nodes but enforce the same invariant. The themed
  layout also matches how the docs reference these (`docs/auth.md` ↔
  `validators/auth.ts`). Lesson: a file boundary that matches the
  user-visible concern is more durable than one that matches a parser
  artifact.

- **Two-layer registries: typed SSOT + name-only mirror pinned by a
  completeness test.** The walker-primitive registry pattern (W1B-C):
  `src/generator/_walker/registry.ts` is the typed dispatch table
  (each primitive carries its renderer function); `src/language/
  walker-stdlib.ts` exports name-only `Set<string>`s for the validator
  to consult. The layering rule forbids `language/` from importing
  `generator/`, so the names are hand-listed in the mirror — but a
  completeness test (`walker-stdlib-completeness.test.ts`) pins them
  mechanically against the registry. Drift surfaces as a test failure
  with an actionable diff. Same pattern then applied to derive
  `STDLIB_LAYOUT_COMPONENTS` (body-walker.ts) and `STDLIB_PRIMITIVES`
  (validators/ui.ts) from the same SSOT (PR #638). Lesson: when a name
  list lives in two places because of a layering constraint, don't try
  to remove one — pin the other to the first with a test.

- **`mk<X>` builder pattern for closed-set AST construction.** PR #619
  introduced `src/macro-api/_mk.ts`: a single `mkAst<T>(node)` generic
  carrying the one structural-typing escape hatch, with thin per-type
  wrappers (`mkProperty`, `mkTypeRef`, `mkStateField`, etc.) the macros
  call. Net: 29 `as unknown as <AstType>` casts in
  `factories.ts`/`ui-factories.ts` → 1 internal cast in `_mk.ts`. The
  pattern then extended to `crudish.macro.ts` (PR #628) and the web
  builder's AST construction sites (PR #638). Lesson: when a structural
  cast is genuinely needed (Langium AST types model the post-link
  state; pre-link literals legitimately lack `$container`), centralise
  it in ONE generic wrapper rather than scattering it across every
  author site.

- **Parallel maintainer activity is the dominant rebase cost on small
  PRs.** Across the substrate series, several PRs hit `dirty` /
  `unstable` GitHub mergeable states because the maintainer was running
  the Phase A Item 1 walker-target delegation (PRs #607, #610, #612,
  #616, #622-#627) in the same files (body-walker.ts, surface.ts,
  enrichments.ts). Mitigations that worked: (a) keep each PR scoped to
  ≤ ~10 files, so rebase conflicts are mechanical comment-text merges
  rather than logic merges; (b) merge fast — the PR that sat dirtiest
  the longest (W2-C, PR #606) had to be rebased three times before it
  landed. Lesson: when working alongside parallel activity in the same
  files, optimize for cheap rebases over comprehensive scope.

- **Commit-per-logical-group is the cheapest crash insurance for
  long-running agents.** Two agents during this work hit rate limits
  (529 overloaded) mid-task — once during F1 (after touching 11 files),
  once during the web-builder migration. The agent that committed each
  item before moving to the next preserved its work; the agent that
  batched commits at the end lost progress and required a second
  dispatch to pick up. Other mitigations: prefer `grep -n` over
  `Read`, skip full `npm test` runs between commits (only at the end
  and after high-risk groups). Lesson: a multi-item agent task should
  treat the remote branch as a checkpoint store, not a final
  destination.

- **The "deferred" item often becomes the next PR's surprise scope.**
  Items deferred from PR #628 (the STDLIB_LAYOUT_COMPONENTS derive,
  blocked by a safety gate on body-walker.ts activity) ended up
  defining PR #638's scope when the gate cleared. The pattern: a small
  deferral list in the PR body is enough if it's actionable; what
  doesn't work is "we should fix this someday" buried in a code
  comment. Lesson: every deferral that survives a PR needs either a
  tracking item or an inline TODO with a grep-able tag — otherwise it
  drifts.

## The "Specification" / "Criteria" naming quirk across frameworks

The DDD Specification pattern is named **inconsistently — and sometimes
backwards — across the frameworks Loom targets**, so reusing a
framework's term for a generated type silently hands the reader the wrong
mental model. Map (this surfaced designing reified criteria, see
`docs/plans/retrieval-implementation.md` Phase 5 + `reified-criteria.md`):

| Framework | `Specification<T>` means | `Criteria*` means |
|---|---|---|
| **Ardalis (.NET)** | the **whole query** — `Where`+`OrderBy`+`Include`+`Skip/Take` → maps to Loom **`retrieval`** | — |
| **Spring Data (Java)** | **predicate only** (`toPredicate → Predicate`) → maps to Loom **`criterion`**; the bundle is `findAll(spec, Pageable)` | — |
| **JPA (Java)** | — | `CriteriaBuilder`/`CriteriaQuery`/`Root` = the typed **query-builder API**, *not* a predicate → collides head-on with Loom's `criterion` (which *is* a predicate) |
| **Hibernate (legacy)** | — | the deprecated `Criteria` session API — yet another meaning |

So "Specification" sits at the **retrieval** layer in Ardalis but the
**criterion** layer in Spring, and "Criteria" means a *query builder* in
JPA but a *predicate* in Loom. **Lesson:** in generated code prefer
Loom-owned neutral names (`Criterion<T>` = predicate, `Retrieval<T>` =
query bundle) and treat the framework types (Ardalis `Specification<T>`,
Spring `Specification<T>`, JPA `Criteria*`) as **internal rendering
details of each backend's emitter**, never the shared vocabulary. The
neutral IR concepts are `CriterionIR` / `RetrievalIR`; the framework name
is a rendering target, not the concept.

## Stacked refactor PRs: rebase before you branch, not at merge

Splitting three oversized generator files into thin orchestrators + leaf
modules (PRs #866 phoenix `shell-emit`, #868 ts `repository-find-builder`,
#869 dotnet `cqrs-emit`) was pure code-motion and went green on the fast
suite first try. The cost was entirely in **branching all three off a
stale local `main`** — the checkout predated `main`'s Dapper PR (#855),
which had threaded a `usingDapper` option through `cqrs-emit.ts`.

The trap is that **disjoint files hide the staleness until the squash**.
The phoenix and ts splits touched files `main` hadn't moved, so they
squash-merged clean and *looked* like proof the base was current. Only
#869 — whose file #855 *had* edited — surfaced the drift, and it surfaced
as a GitHub merge conflict (405) *after* CI had already passed, not as a
local build error. Recovery was a `git reset --hard origin/main` + re-apply
the split on the now-Dapper-aware monolith (porting the `usingDapper`
threading into the extracted `emitController`), then force-push.

A second, smaller instance rode along: the only red CI check on #869 was a
pre-existing `expect`-not-imported bug in an unrelated LSP test that `main`
fixed in #884 — invisible until I merged `main` in. (Merging `main` also
pulled in #883's Biome warn→error elevation; the new modules passed it
clean, but that's another thing a stale base would have missed.)

**Lessons:**

- **`git fetch origin main` and branch from `origin/main`, not whatever
  was checked out** — especially for a multi-PR refactor sequence. The
  container's clone can be hours behind a busy `main`.
- **A clean squash-merge of a disjoint-file PR is not evidence the base is
  current.** Only a PR that overlaps an upstream edit will tell you, and it
  tells you at merge time. Don't infer "base is fresh" from the easy ones.
- **For a stack, merge down fast and refresh the next PR against the new
  `main` immediately** (retarget base + `git merge origin/main` or rebase),
  rather than letting all three sit on the original base. Re-running the
  full CI matrix after the `main` merge is what caught both the Dapper
  drift and the unrelated red test.
- **The fix for the stale monolith is reset-and-replay, not conflict
  resolution.** Hand-resolving `<<<<<<<` markers across a 700-line
  code-motion diff is error-prone; resetting to `origin/main` and
  re-applying the (small, well-understood) split on top is faster and
  safer.

## `unknown` silently disables the AST type checker — a new bindable type needs the full path

Letting workflow `create`/`handle` params reference an `event`/`payload`
by name (PRs around the queueing-abstraction branch) surfaced a sharp
gotcha in `src/language/type-system.ts`. The operand validators
(`checkBinaryOperands`, comparison/logical checks) **cascade-suppress
whenever either operand types as `unknown`** — a deliberate
anti-double-reporting rule. So a parameter whose type resolves to
`T.unknown` doesn't just lose hover info: *every* field-level type check
on it (`e.amount && true`, `e.amount == "x"`) is silently skipped, no
diagnostic. A bug that looks like "missing validation" is really
"receiver typed `unknown` → suppression."

Two non-obvious consequences when adding a new bindable param type:

1. **It needs a real `DddType` kind, not `unknown`.** Reusing `unknown`
   as a placeholder "we don't model this yet" is not free — it actively
   disables checking on anything built from it.
2. **Member access resolves through `typeAfterSuffix` (the postfix-chain
   path), not `stepInto`.** `stepInto` is only the assign/path-typing
   walk. The binary-operand validator types `a.b` via
   `typeOfPostfixChain → typeAfterSuffix`. Adding an arm to `stepInto`
   alone changes nothing the validator sees — you must add the
   `typeAfterSuffix` arm (and `typeToString`/`typesEqual`/`membersOfType`
   for completeness; the `typeToString` switch is exhaustive so the
   compiler flags that one for you, but `typesEqual`/`membersOfType` have
   `default` arms and won't).

Also: `on`/`apply` event params are a `LooseName` + cross-ref, **not** a
`Parameter`, so `envForNode`'s param-list loop never binds them — they
need an explicit `bindings.set` or they stay `unknown` (same suppression)
even after the type kind exists.


## Exception-less producer returns — Phoenix is the odd backend out

`operation foo(): X or NotFound { return … }` (exception-less.md, A3)
ships **real execution on Hono + .NET but is deferred on Phoenix**, and
the reason is architectural, not effort: each backend's operation seam
either does or doesn't have a place to put a union result.

- **Hono** — the operation lowers to a plain domain *method*; it already
  returns an arbitrary value, so it returns an inline tagged union and the
  route translates. Trivial seam.
- **.NET** — the operation lowers to a CQRS *command handler* that already
  returns `TResponse`; switch it from `Unit` to the union. The only friction
  is layering (Domain can't name the Application wire DTO), solved with a
  *pure Domain union* + a controller that maps the success variant to the
  `[JsonPolymorphic]` Application DTO. See `cqrs/dtos.ts:domainUnionFiles` +
  `cqrs/controller.ts:buildReturnUnionSpec`.
- **Phoenix** — the operation lowers to an Ash **`update` action**: its body
  runs inside `change fn changeset, _ -> … changeset end` and the action's
  result is the **resource struct**. There is **no seam for a union return** —
  a `change` function must return a changeset, not a `%{type: "…"}` map. Real
  execution requires re-emitting union-returning ops as Ash **generic actions**
  (`action :op, :map do run fn … -> {:ok, tagged_map} end end`), which also
  means the operation-body renderer (today changeset-shaped) needs a
  generic-action mutation form. Scoped out for now; the gate
  (`loom.operation-return-unsupported`, `SUPPORTED_RETURN_BACKENDS`) keeps it a
  hard error. Full design in exception-less.md → "Implementation status".

Lesson: before promising "translate this to every backend," check whether
each backend's operation lowering target *returns a value at all*. A model
that returns a fixed framework type (Ash's resource record, EF's `Unit`) has
no free seam for an arbitrary result — and Ash's is the one with no escape
hatch short of changing the action kind.

## Verifying generated Phoenix locally is blocked by the egress proxy (Erlang httpc ≠ curl)

Building the Phoenix dispatch feature (#1020) with no local `mix compile`
forced a workaround hunt. What's reproducible behind this environment's
TLS-intercepting egress proxy:

- **Pulling the CI Elixir image:** `docker pull hexpm/elixir:…` hits the
  Docker Hub anonymous rate limit. **Google's mirror works:**
  `docker pull mirror.gcr.io/hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim`,
  then re-tag to the canonical name so the test harness finds it.
- **Trusting the proxy CA inside the container:** mount the host's
  `/usr/local/share/ca-certificates/` (the `egress-gateway-ca-*` /
  `sandboxing-egress-ca` / `swp-ca-*` certs), `cp` them in, and
  `update-ca-certificates`. This fixes the TLS `unknown_ca` handshake error.
- **The hard wall — `mix deps.get` cannot reach hex.pm.** With TLS trusted,
  **curl to `builds.hex.pm` / `repo.hex.pm` is a reliable 200**, but
  **Erlang's `httpc`** (what `mix local.hex` and Hex's downloader use) gets a
  reliable **503 "upstream connect error … connection termination"** from the
  egress Envoy. Tested and ruled out: explicit `server_name_indication`,
  TLS-1.2-pinning, spacing/retries, a curl-downloaded local `hex.ez` via
  `mix archive.install`. The proxy keys its upstream decision on something in
  Erlang's TLS ClientHello that curl's doesn't trip (SNI-forward-proxy /
  JA3-style). So **`mix compile` against real Ash 3.x is not runnable here** —
  the dep tree can't be fetched without re-implementing Hex's resolver over
  curl (disproportionate).

**What you *can* do locally as a substitute:** generate the project and
syntax-check every emitted file with `Code.string_to_quoted!` in the Elixir
image — it parses (catches indentation / `do`-`end` / unbalanced-delimiter
errors across the whole tree) without needing deps. It does **not** catch
`--warnings-as-errors` traps (unused alias/var, undefined refs) or Ash
semantics — so write the emitters defensively (fully-qualified module refs so
no unused `alias`; underscore statically-unused vars; `require Logger` only
where a `Logger` macro is used) and treat the **elixir-vanilla compile CI
job as the authoritative gate**. (The Ash foundation has since been removed;
`platform: elixir` compiles against plain Ecto/Phoenix.) On #1020 the local syntax pass + careful
emission got it green on the first CI compile.

Lesson: in this sandbox, curl ≠ Erlang/httpc for outbound TLS. Don't assume a
toolchain that "has network" can fetch — check the *specific* client.

## Ash's action model keeps not fitting Loom's imperative persistence — the saga state is deliberately Ecto, not Ash

**(Superseded 2026: the "open product question" below was resolved by removing the Ash foundation entirely — `platform: elixir` now generates plain Ecto/Phoenix only, and `foundation: ash` is a validation error. The friction log is kept for the historical rationale.)**

Recurring theme, now with a third data point. Loom's Phoenix backend models
**aggregates** as full `Ash.Resource` (AshPostgres data layer), but several
persistence paths are deliberately kept **off the Ash action surface** because
Ash models writes as changeset-shaped actions (`create`/`read`/`update` with
accept-lists, change chains, authorizers) over a data layer that assumes it
answers queries about *current state* — and Loom's non-CRUD write paths don't fit:

- **Event sourcing on Phoenix/Ash — deferred** (`workflow-and-applier.md`): the
  emit/apply, no-state-table, fold-on-load contract can't ride Ash's changeset
  actions + queryable-data-layer callbacks without a custom data layer or leaky
  half-bridges. The escape hatch is the `foundation: vanilla` axis (plain Ecto),
  not the platform.
- **Workflow saga/correlation state — plain `Ecto.Schema`, by design**
  (`channels.md`, `dispatch-emit.ts`): the dispatcher mutates the saga row
  imperatively — *load-or-allocate* on a `create` starter, *route-or-drop+log*
  on an `on` reactor. That's routing/correlation bookkeeping, not domain CRUD,
  so it's read/written through the app `Repo` (`AshPostgres.Repo` is itself an
  `Ecto.Repo`) over the shared `MigrationsIR` table — keeping it off Ash.
- **Workflow-instance views on Phoenix — deferred** (`workflow-instance-views.md`):
  because the saga state is Ecto, a workflow-sourced `view` can't reuse the
  aggregate view's `Ash.Query.filter` path. Promoting the saga to an Ash
  resource to fix the *read* side would drag the imperative *write* path onto
  Ash actions — re-introducing the very friction the Ecto choice avoided. So the
  read stays Ecto if/when built (Ecto `where` + a shared camelCase encoder for
  the plain struct).

Lesson: when a persistence path is imperative / non-CRUD / non-current-state
(event streams, saga correlation, upsert-by-key), Ash fights you. Reach for plain
Ecto over the shared `Repo` and keep it off the action surface. The frictions are
accumulating enough that whether the Ash foundation is carried further at all is
an open product question — design new Phoenix work so it doesn't *deepen* the Ash
coupling.

## Svelte frontend port (svelte-frontend-plan.md)

What the second `WalkerTarget`-consuming frontend taught us:

- **Svelte 5 is close enough to JSX that the shared walker held.**
  `{expr}` interpolation, `<Comp x={y}/>` invocation and
  `data-testid={expr}` are byte-compatible; the divergences fit in six
  new contract methods (4 markup seams + children slot + form-runtime
  imports).  The roadmap's fear that Svelte's "compiler-driven
  reactivity is a bigger shape delta" did not materialise — runes read
  like plain JS, and plain-assignment state writes are SIMPLER than
  React's setter convention.
- **svelte-query v6's runes adapter is the load-bearing luck.**
  `createQuery(() => opts)` returns a reactive object with the
  React-Query property surface, so the api factories keep the TSX hook
  names and the walker's api seam needed zero new contract surface.
  Validate the data-layer library's adapter FIRST when porting a
  frontend — everything else hangs off it.
- **Prototype the generated project before writing templates.**  A
  hand-built /tmp SvelteKit probe (install → svelte-check → vite
  build) caught the version matrix (vite-plugin-svelte 4 vs 5,
  @types/node, adapter fallback behavior) in minutes; encoding wrong
  pins into stack partials would have cost a CI-roundtrip each.
- **Handlebars + Svelte braces: one real collision.**  `{{x}}}` (a
  double-stash immediately followed by a literal `}`) lexes as a
  triple-stash close.  The fix is mechanical — insert a space
  (`{{x}} }`) — and worth a regex sweep over any new svelte pack.
- **One-component-per-file forced one real design move:** React's
  module-scope operation-form components became page-scope
  `{#snippet <op>OpModal(form)}` blocks parameterised by their form
  instance.  Snippets close over page state, so the modal-open flag
  stays a plain `$state` local.
- **Byte-identical gates made the React-side refactors safe**: the
  walker-core move, the zod-schema extraction, the page-object/
  harness moves to `_frontend/`, and the `formRuntimeImports` seam all
  shipped with an empty showcase full-system diff against main.

## Money-primitive forms vs the zod resolver (2026-06-12)

- **The schema sees what the *control* writes, not the wire shape.**
  `moneySchema` was `z.string().transform(→ Decimal)` — correct for
  parsing wire JSON, but every pack's money input control converts on
  change (`field.onChange(new Decimal(...))`), so the zodResolver
  validated a Decimal *instance* against `z.string()` and every
  money-primitive form failed submit with "Expected string, received
  object".  Fix: `z.union([z.instanceof(Decimal), z.string()])` with an
  instance pass-through ahead of the string parse.  The gap survived
  because the e2e fixtures exercise the Money *value object*
  (`z.number()` amounts), never the `money` primitive, in a form —
  when a schema is shared between wire parsing and form validation,
  test BOTH inbound shapes behaviourally (the new
  `money-schema-runtime.test.ts` transpiles + executes the template).
## Vue frontend (Phase B): what the second SPA target taught us

- **The walker-contract bet paid off, with a twist.**  Vue needed
  three NEW seams (`renderInterpolation`, `renderAttrBinding`,
  `renderMatchChild`) — exactly the places Vue diverges from the JSX
  family where Svelte doesn't (mustaches, `:attr` bindings, no
  markup-valued ternaries).  Every extension was byte-identical for
  TSX/HEEx, gated by the baseline fixture re-capture.  Lesson: budget
  for contract growth when the new framework's TEMPLATE language
  differs, not just its state model.
- **Render-position is subtler than "template vs handler".**  The
  original vueTarget design put `.value` on handler-position state
  reads — wrong, because EVERYTHING the walker emits lands inside the
  SFC template (inline `@click` handlers are template-scoped and Vue
  compiles unwrapped-ref assignment).  Only the page shell's own
  script code touches `.value` — including a targeted rewrite of
  hook-hoist args, the single script-position landing site for
  walker-rendered expressions.
- **Quote discipline is a pack-authoring contract.**  Rendered JS
  carries double-quoted string literals, so every JS-splicing
  attribute in a vue pack is single-quoted (`@click='{{{onClick}}}'`),
  and `vueTarget.renderAttrBinding` picks the collision-free quote
  (throwing on mixed quotes).  A sweep test greps emitted `.vue` for
  JSX artifacts + unrendered Handlebars.
- **vue-query's nested refs**: hoist handles as `reactive(useX(...))`
  so `x.data` reads correctly in template AND script.  Plain captured
  args mean find-filters don't live-refetch yet — `MaybeRefOrGetter`
  api params are the follow-up.
- **Agent-translated packs work** (vuetify: 53 templates, shadcnVue:
  ~100 incl. ui sources) when the prompt pins VM-field fidelity, the
  escaping rules, and an end-to-end compile gate; the orchestrator-
  side review then focuses on the handful of contract spots (form
  bindings, dialog wiring, quote collisions) the gates surface.
## EF's PascalCase default silently diverges from the snake_case migration DDL — and only a *live query* catches it

The .NET backend 500'd on every `INSERT`/`SELECT` with `42703 column "Id" of
relation "projects" does not exist`. Cause: EF entity configs emitted no
`HasColumnName` for scalar properties (and only `HasConversion`, no column name,
for id/enum properties), so EF defaulted to the **PascalCase CLR property name**
(`Id`, `CreatedAt`, `ExternalId`) while the shared `MigrationsIR` DDL — and the
Hono/Phoenix backends — use **snake_case** (`id`, `created_at`, `external_id`).
The owned-collection FK was a name mismatch too: EF's default `ParentId` vs the
migration's `<parent>_id`. Fix: emit an explicit `.HasColumnName(snake(field))`
on every mapped column (scalars, PK, id-refs, enums), suppressed only in the
embedded `ToJson` shape where members are JSON keys, not columns.

The real lesson is the **feedback-loop gap**, not the mapping. This never worked
at runtime, yet survived because the only per-PR .NET gate (`dotnet-build`)
checks **compilation**, never a live query — and the behavioral run that *does*
hit Postgres (`conformance-full`) is nightly-only, and was itself masked by an
earlier missing-tables bug. A whole class of "compiles fine, 500s on first
request" defects hides in that gap. Mitigations now in place: a unit test pins
every emitted `HasColumnName` against the DDL column (asserting **no** PascalCase
column survives), so the divergence is caught at `npm test` rather than waiting
for a nightly boot.

Lesson: when two backends must agree on an external contract (here, Postgres
column identifiers across the EF mapping and the `MigrationsIR` DDL), pin the
agreement in a fast unit assertion — don't rely on a heavy, nightly, easily-masked
e2e run to be the first thing that exercises it.

---

## 14. Compiling generated backends in Docker (and the TLS-fingerprint proxy 503)

Docker **is** available in the remote/sandbox environment — the container ships
the Docker client but no running daemon. Start one with `dockerd >/tmp/dockerd.log
2>&1 &` (root + passwordless sudo). It doesn't persist; if `docker info` starts
failing mid-session, just relaunch it. Image pulls from Docker Hub and
`mcr.microsoft.com` work through the standard egress.

Verified end-to-end (generate → compile) for every backend that lacks a host
toolchain or runs in a container:

- **Java** — `gradle testClasses bootJar` on the host (JDK 21 + Gradle present).
- **.NET** — host has no SDK, so build in `mcr.microsoft.com/dotnet/sdk:10.0`
  (matches the `net10.0` target); `dotnet restore` + `dotnet build /warnaserror`
  are clean. NuGet sails through the egress proxy.
- **Phoenix/Elixir** — `mix deps.get && mix compile --warnings-as-errors` in the
  `hexpm/elixir` image, against the vanilla Ecto/Phoenix dep set. (The Ash
  foundation was removed; `platform: elixir` now generates plain Ecto/Phoenix.)

### The gotcha: egress proxies that allowlist by TLS fingerprint

The hard part wasn't Docker — it was that this environment's egress gateway
**allowlists by the client's TLS fingerprint**. Requests from the system
OpenSSL (curl, Python stdlib `ssl`, .NET, Gradle, Node? — see below) get
`200`; requests from **Erlang/OTP's `:ssl` get a bare HTTP `503`** even though
the CA is trusted, SNI is correct, and `openssl s_client` from the *same
container* returns `200`. Symptom: `mix local.hex` / `mix deps.get` fail with
`{:bad_status_code, 503}` (or "Unknown CA" before the proxy CA is injected).

Ruled out, one at a time: CA trust (CA injection changes the error from
"Unknown CA" to 503), docker bridge NAT (`--network host` doesn't help),
User-Agent, and SNI (forcing `server_name_indication` doesn't help). It is the
TLS client itself. **mitmproxy as a re-originator also fails** — its bundled
OpenSSL is rejected too. **Node's https client was rejected as well** (got
`200` standalone once, but `503` re-originating), so the mirror is **Python
stdlib `ssl`**, which is reliably accepted (134/134 fetches in a full build).

### The workaround: `scripts/hex-mirror.py` + `LOOM_HEX_MIRROR=1`

A loopback TLS-terminating mirror: Erlang does clean localhost TLS to it
(gateway never in that hop), and it re-originates to hex.pm with Python's
stdlib `ssl` (the accepted fingerprint). Wiring (`test/e2e/support/hex-mirror.ts`):
`docker run --network host --add-host {builds,repo,hex}.hex.pm:127.0.0.1`, mount
the mirror CA, and — the subtle bit — set **`HEX_CACERTS_PATH`** to the OS bundle:
`mix local.hex` uses Erlang's `:httpc` (OS trust store, so `update-ca-certificates`
suffices) but **`mix deps.get` uses Hex's *own* CA bundle**, so without
`HEX_CACERTS_PATH` it rejects the mirror cert with "Unknown CA". Bytes pass
through verbatim, so Hex's registry signature + tarball checksums still verify.

Lesson: when a sandbox "can't reach the internet", check *which client* — a 503
that an identical `openssl`/curl request doesn't get is a fingerprint allowlist,
not a network block. The fix is to re-originate through an accepted client, not
to fight the CA.

### Gradle hits the same wall — but only *inside* the container

The generated Java Dockerfile's Gradle stage fails plugin/dependency
resolution behind the same proxy: the in-container JVM's TLS fingerprint is
rejected while the **host** Gradle (same repos, same proxy) resolves
everything. No mirror needed here — the workaround is simpler than Elixir's:
`gradle bootJar` on the host, copy the jar into the build context (mind
`.dockerignore` — it excludes `build/`, so `cp build/libs/app.jar app.jar`
first), and containerise it with a three-line `FROM eclipse-temurin:21-jre`
Dockerfile. Recipe in `docs/tools.md` → "Java images behind a fingerprinting
proxy". Sandbox-only; the shipped Dockerfile stays two-stage.

### Recreating the bundled Keycloak rotates the realm keys

Two traps when bouncing the dev IdP mid-session: (1) the realm import runs
only on **container creation**, so `docker compose up -d keycloak` after a
config edit silently keeps the old realm — use `--force-recreate`; (2) a
recreated Keycloak generates **fresh realm signing keys**, so any backend
that cached the old JWKS keeps 401-ing valid new tokens. That second trap is
a *real production scenario* (IdP key rotation), not just a sandbox quirk —
it's why every generated verifier must refetch the JWKS on a kid miss
(rate-limited) instead of caching it forever. jose's `createRemoteJWKSet`
(Hono), `PyJWKClient` (Python), and Nimbus's `JWKSourceBuilder` default
source (Java) all do this out of the box; the hand-rolled Phoenix and .NET
verifiers need it wired explicitly (kid-miss `:persistent_term` refresh /
`ConfigurationManager.RequestRefresh()` + one retry).

## 15. Derive, don't stamp — and when you delete machinery, sweep its footprints

This is the retro for the scaffold-page-kind cleanup (PRs #1408 → #1441). It
fixed a class of slow-accreting debt, and the cheapest way to keep it from
re-accreting is to recognise the three shapes it took.

### Prefer derive-on-demand over a denormalized IR field

A page's **kind** (aggregate list/new/detail, workflow form/instances, view
list, home/workflows-index/views-index, custom) used to be stamped onto the IR
node twice — once as `PageIR.origin`, once as a `source: "scaffold" | "explicit"`
tag — and then read back later. Both were **denormalized restatements of facts
already present** in the node: its role-scoped name and its `area`. The stamp
*looked* convenient but it (a) had to be kept in sync at every construction
site, (b) leaked the macro layer's intent into the IR vocabulary, and (c) was
the root of the "magical interference" bug — a hand-written `Home` page got the
scaffold stamp's behaviour because the classifier trusted the stamp instead of
the name.

The fix was to delete both fields and compute the kind on demand from the name +
area via `classifyPage` (`src/ir/util/page-kind.ts`). **Rule of thumb:** if a
field is a pure function of other fields already on the node, don't store it —
write the function. Store a fact only when it's an *input* the pipeline can't
re-derive (a user-authored choice, a non-deterministic id), never when it's a
*classification* of inputs you already hold. A stamped classification is a cache
with no invalidation story; the bug is when (not if) a construction site forgets
to populate it.

### A macro should emit its full expansion, not a sentinel expanded later

The dashboard pages (`scaffoldHome` / `scaffoldWorkflowsIndex` /
`scaffoldViewsIndex`) used to be emitted by the macro as a **placeholder call**
that a *later lowering sub-pass* (the deleted phase ⑤c,
`expandInlineScaffoldPrimitiveCalls`) rewrote into the real page body. That
split one feature across two layers for no reason: the macro layer **already has
the full inventory** (`aggregatesIn` / `workflowsIn` / `viewsIn`), so it can
build the complete AST body up front like every other scaffold macro. The
sentinel bought nothing and cost a whole extra pass, a stamped marker to find
the sentinels again, and a second mental model. **Rule of thumb:** a macro emits
real, final AST (so `unfold` ejects real `.ddd` source); if you find yourself
emitting a marker "to be filled in later," check whether the later pass has any
information the macro lacks — usually it doesn't, and the deferral is
accidental, not essential.

### When you delete machinery, the references outlive it — sweep them

Removing `origin` / `source` / phase ⑤c took **five follow-up PRs** (#1416 the
code, #1431 the docs, #1438 + #1441 the comment/test drift) because the deleted
concepts lived on in: header comments describing the old sub-pass, doc-comments
on *adjacent* fields (`route` / `emitPath`) that mentioned the dead one, test
*names* and framing (`walker-primitive-expander.test.ts` → `scaffold-page-bodies.test.ts`),
and prose in `docs/` + `CLAUDE.md`. Each scrub claimed "all done"; each next
grep found more. **Rule of thumb:** deleting a concept isn't done when the code
compiles — grep the *name of the concept* (not just the symbol) across `src/`,
`test/`, `docs/`, `CLAUDE.md`, and this file, including comments and test
titles, in one pass. A symbol the compiler removed for you is the easy 20%; the
prose that still teaches the dead model is the lingering 80%.

### One concrete gotcha from the rewrite: `PageNameCtx` is arrays, not iterators

`classifyPage` takes a `PageNameCtx` of `{ aggregateNames, workflowNames,
viewNames }`. These must be `readonly string[]`. An early version passed
`Map.keys()` iterators straight through; the first page consumed each iterator
and every subsequent page saw an empty set and was misclassified (it surfaced as
a workflow-form page emitting to the wrong path). **Lesson:** a context object
reused across a loop must hold re-iterable collections — materialise
`[...map.keys()]` at the boundary, never hand a single-use iterator to a helper
that's called per element.

## 16. The `store` feature (Stage 5) — two gotchas and one seam decision

### `[]` (adjacent) is lexed as the array-type marker, not an empty-list literal

The grammar's array-type suffix `'[]'` is a single token. So in *expression*
position a bare `[]` (e.g. `lines := []`, or a `state { xs: T[] = [] }`
initializer) is lexed as that token and fails to parse as an empty `ListLit`.
Workarounds: write `[ ]` (spaced — the tokens separate) or omit the initializer
(the array zero-value already IS `[]`). This bit the store example's `clear()`
action and surfaced a latent **printer** bug too — `printExpr` re-emitted an
empty `ListLit` as `[]`, which then wouldn't round-trip; the fix was to print an
empty list as `[ ]` (`src/language/print/print-expr.ts`). Lesson: a
single-token operator that also looks like a two-token literal is a lexer trap;
the printer must emit the spaced form to stay round-trippable.

### Dotted UI refs resolve at LOWERING, not in the scope provider

`Cart.lines` / `Cart.clear()` are NOT Langium cross-references — page/component
bodies parse `NameRef` + `PostfixSuffix` as plain strings (`name=NameRefIdent`),
so the scope provider never sees them. Resolution happens in `lower-expr.ts`
(`applySuffixToRecv`, against an `env.stores` index) — a `<Store>.<field>`
becomes a `refKind:"store-field"` ref carrying the store name, a
`<Store>.<action>()` becomes a `callKind:"store-action"` call. This is the
fully-resolved-IR invariant in action: the emitter reads the store name off the
ref/call, never re-resolves. (The reviewer's "mirror UiNotification/MenuLink"
note meant *resolve at IR-time, not emit-time* — UiNotification DOES use a real
cross-ref because its `param`/`event` are grammar references; the body-expr
store refs are the lowering-time analog, since there's no cross-ref to hang a
scope rule on.)

### The walker store seam touches THREE ref sites, not one

A store-field read reaches the JSX walker at three independent points:
`emitExpr`'s `ref` arm (handler/expression position), `walk`'s `ref` arm
(markup-child position), and `renderTextContent`'s `ref` branch (a primitive's
text arg, e.g. `Heading { Cart.count }`). Each had its own bare-name fallback
(`renderComment("ref: …")`). A new ref *kind* has to be wired into all three or
it silently degrades to a `{/* ref: x */}` comment in whichever position the
test example didn't exercise — caught here only because the example put
`Cart.count` in a `Heading` text slot. Lesson: when adding an `ExprIR` ref
shape the walker must render, grep every `renderComment(`ref:` fallback, not
just the first one.

### A new keyword breaks plain-`ID` positions the soft-keyword escape hatch can't reach

Stage 5 first shipped a `StoreLifetime` grammar (`store Cart persist: local`),
introducing `persist`/`sync`/`local`/`session`/`url` as keyword tokens. That
turned `main` red one merge later: `operation sync() { … }` and a `url: string`
field stopped parsing, because **operation/aggregate/event NAMES are
`name=ID`** — and you cannot soft-admit a word into a plain `ID` position
without rewriting every `name=ID` to a name-rule. The soft-keyword escape hatch
(adding `'sync'` to `LooseName`/`MemberName`/`NameRefIdent`/`Property.name`)
covers field/param/member-access/NameRef positions, but NOT declaration names.
`store` itself was fine (a *field* named `store` only needs the soft-keyword
rules), but the lifetime words were too common and landed in declaration-name
positions. **Resolution:** drop the lifetime *surface* entirely for v1 (the IR
field + `loom.store-lifetime-unsupported` gate stay, defaulting to `"memory"`),
so the persistence follow-up adds syntax later with the soft-keyword care it
needs. **Lesson:** before adding a bareword keyword, grep the example/test
corpus for it as an identifier — if it appears as an operation/aggregate/event
*name* (plain `ID`), a soft keyword can't save you; either pick a
collision-free spelling or defer the surface. The heavy per-backend gates
(elixir/dotnet/java generate-and-compile) are where this surfaces — a narrow
grammar diff's fast tests can stay green while a generated-backend example with
the now-reserved identifier fails to parse downstream.

## 17. A long docs/parity audit's base rots *under it* — re-verify cited code right before commit (2026-06-28)

§"Stacked refactor PRs" covers a base that's stale *when you branch*. This is the
sharper sibling: a base that goes stale **during** a single long audit, where the
deliverable is *prose asserting what the code does* — so when the code moves
mid-task, your half-written edits silently become **wrong**, not just behind.

**What happened.** A docs status-refresh of the tenancy/capability-filter claims
synced `main` at start (`740b823`), read `system-checks.ts`
(`supportsNonRelationalFilter` omitted python), and wrote edits asserting *"python
wires relational filters only / no non-relational filters."* By push time `main`
was `d2b8e70` — **#1571 had landed python `shape(embedded)` filters mid-session** —
so every "python relational-only" edit was now false. It was caught **only** by a
rebase conflict in `platform-parity-debt.md`, which `main` had *also* refreshed
(#1549/#1571), partly duplicating the work. Without that overlapping-file collision
the wrong claims would have shipped green.

**Lessons.**

- **For an audit that treats code as ground truth (status-refresh, parity-auditor),
  re-fetch `main` and re-read the *cited lines* right before committing — not just
  at session start.** "The code wins, every time" has a time axis: the code that
  wins is the code at commit time. A claim verified against an hour-old base is a
  claim against behaviour that may no longer exist.
- **A rebase conflict is a *lucky* detector, not the design.** It only fired because
  `main` happened to touch the same file. Don't rely on it — the disjoint-file case
  (your audit edits a doc `main` didn't touch, but cites code `main` *did* change)
  drifts silently, exactly as the stacked-refactor §warns for code.
- **Check whether `main` already did your audit.** Parallel agents refresh the same
  trackers; before a docs/parity sweep, `git log origin/main` the target files +
  `list_pull_requests` — #1549/#1571 had already flipped the same cells.

### Sub-gotcha: `git reset --hard origin/main` **on a feature branch** discards your branch commits

A skill's "orient on fresh main" step literally says `git fetch origin main && git
reset --hard origin/main`. That is safe on a throwaway/clean checkout but
**destructive when you're on a feature branch carrying commits** — it moves the
branch ref to `origin/main`, dropping your work from the local branch and working
tree. Hit live this session at finalize time (commits `af888fa`/`e215079` vanished
locally). **Recovery:** they were pushed, so `git reset --hard
origin/<feature-branch>` restored them (the reflog `HEAD@{1}` also pins the tip).
**Prevention:** when you only need to *compare* against main on a feature branch,
`git fetch origin main -q` and diff/log against `origin/main` — don't `reset --hard`
to it. Reserve the hard reset for when you genuinely want to discard local state.

## 18. Bringing Java into the OpenAPI parity gate — read the *whole* strict-assert list, and the springdoc-customizer pattern (2026-06-30)

`#1618` added Java to the conformance-parity diff (it had been booted but never
diffed since `#1530` — the "ten pairs (5 choose 2)" comment shipped without the
Java pairs). Surfacing it exposed three layers of Java-spec drift, fixed via a
data-driven springdoc `OpenApiContractCustomizer` (`src/generator/java/emit/openapi-customizer.ts`):
response cardinality + RFC 7807 errors, then schema fidelity (named enum
components, empty request-body schemas for param-less ops, per-component
`required` sets = non-optional wire fields), then `ProblemDetails.status`
typing + `Workflow`/`View` operationId suffixes.

Gotchas worth keeping:

- **A document-filter, not new Java types.** Java represents enum fields as bare
  `String` and emits no body for param-less ops, so springdoc's *inferred* spec
  structurally diverges from the hand-built node/.NET/Phoenix/Python specs. The fix
  is a post-hoc `OpenApiCustomizer` that edits the `OpenAPI` model (bake a per-route/
  per-schema contract off the same IR the controllers walk, then register/retarget/
  set on the document) — the established "spec-alignment layer" here, *not* a change
  to the actual Java records. Mirrors .NET's document-filter approach.

- **The strict gate asserts EVERY diffSpecs dimension, not a subset.** Under
  `LOOM_E2E_STRICT_PARITY=1`, `test/e2e/e2e.test.ts` `expect(...).toEqual([])`s all
  ~16 `ParityDiff` arrays (the `isCleanDiff` set), including `propertyTypeDiffs`,
  `requestBodyDiffs`, and `operationIdDiffs`. A subagent mislabeled two of those as
  "non-asserted" and reported "8 dims clean" — they were real gating diffs that
  would have failed CI once the stack booted. **Lesson:** when verifying against a
  gate, verify against the gate's *own* clean predicate (`isCleanDiff` here), not a
  hand-picked subset. `vitest` stops at the first failing `expect` in the pair loop,
  so an early-dimension failure (`onlySchemasRef`) *hides* the later ones — fixing it
  just reveals the next, so drive to the full clean set, not the first green.

- **Parity is effectively transitive through a common reference.** The agent only
  boot-verified node↔java, but node↔{dotnet,python,phoenix} were already clean, so
  java-matches-node ⇒ java matches all four. Verifying one well-chosen pair against
  the reference backend is enough when the others already agree with it.

- **The compose-boot gate flakes on Docker Hub.** A red `parity` run mid-series was
  a base-image-pull `i/o timeout` (`registry-1.docker.io` dial timeout), not code —
  the failed `docker compose build` then cascades to `ECONNREFUSED` on every
  backend port. Distinguish that from a real `diffSpecs` assertion (`X drift
  (node ↔ java)`) before "fixing" anything. The session token can't `rerun`/
  `workflow_dispatch` (403), so re-trigger by pushing the next real commit.

## 19. A CI check-run failure webhook can be a *cancelled run of a superseded head*, not a real failure (2026-07-04)

Pushing a new commit to a PR cancels the in-flight runs on the previous head.
Their jobs report `failure`, and the `<github-webhook-activity>` check-run events
for them keep arriving **after** you've already pushed the fix — so you get a
stream of `tests passed` / `coverage (merge shards)` / `test (shard i/4)`
*failures* that have nothing to do with your current head.

- **The tell is the `HeadSHA` field.** Compare it against the PR's *current* head
  (`pull_request_read method=get`). If the webhook's HeadSHA is an older commit,
  the failure is cancellation fallout — skip it (steward option 3). This session
  burned ~6 investigation cycles confirming events on `02f3ba6` / `3d316a4` /
  `f31ee50` (three successive superseded heads) were all noise.
- **`coverage (merge shards)` failing with `ENOENT: … .vitest-reports` is the
  signature of a cancelled shard set.** The merge job runs `download-artifact`
  for `blob-*`, finds zero (the shards were cancelled before uploading), and dies
  on `readdir` of a missing `.vitest-reports`. That specific error ≠ a test
  failure — it means "the shards never finished," i.e. superseded head.
- **Only the current head's `tests passed` matters for merge.** Don't gate on the
  per-shard checks or on statuses fired on old heads. `pull_request_read
  method=get_status` returns the *legacy commit-status* API (often `pending`/0)
  even when the `tests passed` **check run** is green — read `get_check_runs`, not
  `get_status`, to decide mergeability.

## 20. Retiring an enum-alternative surface: narrow the *rule*, don't delete the *clause* — and "type-consistent emit" ≠ "the feature works" (2026-07-04)

Removing the non-guid aggregate-id kinds (`ids int|long|string`, keeping only
`ids guid`) taught two things.

- **Narrow the alternative rule to the surviving value(s); do NOT delete the
  containing optional clause.** First attempt deleted `('ids' idKind=IdKind)?`
  from the `Aggregate` rule outright — which broke **248 fixtures/examples** that
  spell out the *default* `ids guid` explicitly (a no-op, but pervasive). The
  surfacing was brutal: 155 test failures with `Expecting token of type '{' but
  found 'ids'`. The correct edit keeps the clause and narrows the rule:
  `IdKind returns string: 'guid';` (was `'guid'|'int'|'long'|'string'`). Now
  `ids guid` still parses; `ids int` is a hard parse error. Grep the corpus for
  the default spelling (`grep -rn "ids guid" test/ examples/ web/`) *before*
  touching a shared header clause.
- **A backend emitting *type-consistent* code for a construct is NOT evidence the
  feature works — generate the project and read the create/runtime path.** The
  first cut of this work shipped a validator gate claiming .NET/Java/Elixir
  supported non-guid ids "end-to-end" because their emitters read `idValueType`
  and produced matching PK-column / DTO / param types. Actually generating an
  `ids int` aggregate showed the *create* path mints `new TicketId(0)` against a
  plain `INTEGER NOT NULL` PK (no `SERIAL`/`IDENTITY`) on **every** backend — the
  second insert collides. The feature was non-functional everywhere; guid is the
  only kind `create` can mint a unique value for. Lesson: to judge whether a
  capability actually works, `node bin/cli.js generate system <fixture> -o /tmp/out`
  and read the emitted create + migration, don't infer it from the emitter reading
  the right type. (Corollary: a *gate* is a punt — when a surface is broken
  everywhere, removal beats gating.)

- **Leaving the IR type parameter collapsed to one value is fine.** `IdValueType`
  and `TypeIR.id.valueType` are read across ~48 files (migrations, wire-spec, every
  backend's id emit); excising the parameter is a large no-behaviour-change
  refactor. Narrowing the *grammar* and letting the field always resolve to `guid`
  removes the feature with a ~90-line diff instead of a ~48-file one.

## 21. Converging a forked codegen render path onto the shared renderer (Route A, elixir `shape(document)`, 2026-07-05)

Route A converged the vanilla-Elixir `shape(document)` path off its parallel
map-mode renderer (`RenderCtx.docMap` → `data["field"]`) onto the SAME struct
renderer the relational path uses (`record = row.data` over a typed
`embeds_one :data, <Agg>.Data` embed), then deleted the fork and un-gated
document features. Four merged slices (#1678/#1689/#1696). The lessons below are
the ones that cost real tool-calls and are non-obvious.

- **A design doc's stated *risk / prerequisite* can be silently obsoleted by an
  unrelated fix that merged *after* it was written — re-derive the premise, don't
  trust the doc.** `docs/plans/vanilla-document-route-a.md` risk 2 said typed VO
  *struct* modules were **mandatory** (the only sound fix for the #1660 VO-subfield
  crash). That was true when written — but #1664 had since fixed #1660 a different
  way (a key-agnostic `Map.get(vo, :k, Map.get(vo, "k"))` fallback that works on a
  `:map` VO). So Route A could keep VOs as `:map` and skip all net-new VO-struct
  emission — the single thing that had made slice 1 "bigger than it looks." This is
  the plan-premise twin of §17's "audit's base rots under it": before executing a
  plan, check whether an intervening merge invalidated its *reasoning*, not just its
  line numbers. One `git log`/grep on the cited bug saved a large wasted sub-slice.

- **Two render modes that differ only in a value's *representation* couple every
  consumer of that representation — you cannot slice the conversion per-consumer.**
  Map-mode stored/compared enums as **strings** (`data["status"] == "checkedOut"`);
  the relational struct renderer emits enum values as **atoms** (`:checkedOut`). So
  "convert ops to struct mode but leave finds on map mode" is impossible: the moment
  the `<Agg>.Data` embed's enum field changes representation, BOTH ops and finds (and
  functions, which ops call) break together. The fix was a third render flag
  (`docStruct`) that keeps map-mode's *string-enum + native-money value target* while
  switching field access to struct-dot — so the embed stays `field :status, :string`
  (byte-identical stored jsonb + wire) and every consumer converts in ONE slice. When
  a shared representation forces an all-or-nothing conversion, look for a flag that
  changes *access* without changing the *value target*, rather than fighting the
  coupling.

- **Ecto `embeds_one … on_replace: :update` REJECTS a struct passed to
  `put_embed/3` — it demands a field *map*.** Compile-green, boot-red. An op mutates
  the loaded embed struct in place (`record = %{record | qty: record.qty + 1}`) then
  persists it; `put_embed(:data, record)` raises at runtime
  (`you are giving it a struct/changeset … only allowed to update … as a map`).
  Since the op holds the *whole* mutated struct, `put_embed(:data, Map.from_struct(record))`
  gives the same wholesale-replace effect through the map path. Only a real boot
  (`mix phx.server` + an HTTP round-trip) surfaces this — `mix compile
  --warnings-as-errors` is blind to it, exactly like the §14 class.

- **When boot-verifying in Docker across turns: the egress proxy PORT rotates, and
  the dockerd daemon gets reaped.** `$HTTPS_PROXY` is `http://127.0.0.1:<port>` and
  the `<port>` **changes between turns/sessions** — hardcoding a port I'd read
  earlier gave `econnrefused` (Erlang `:ssl`) and a silent empty container exit. Always
  re-read `$HTTPS_PROXY` at boot time (`-e HTTPS_PROXY=$HTTPS_PROXY`), and mount
  `/root/.ccr/ca-bundle.crt` + set `HEX_CACERTS_PATH`/`SSL_CERT_FILE` so hex.pm
  resolves through the proxy. The elixir container needs `--network host` to reach the
  host-loopback proxy, so publish postgres to the host (`-p 5432:5432`) rather than a
  shared docker network. And `dockerd` does not survive a long compile — relaunch it
  (`sudo dockerd >/tmp/dockerd.log 2>&1 &`) whenever `docker info` starts failing
  mid-boot; a 2-minute foreground poll loop will itself get killed and take the
  backgrounded daemon with it, so start it with `run_in_background`.

- **A red `behavioral-*` check-run can be a flaky race, not your regression —
  check the workflow's recent `main` history before treating it as a blocker.**
  `behavioral-e2e-python.yml` went red on an elixir-only PR (a Python containment
  op → `404 Not Found` immediately after create — a commit/visibility race). It was
  NOT caused by the change (the Python `build-generated-python` gate was green; the
  failing step is a runtime harness race), and the same workflow had failed
  intermittently on `main` itself (one recent run red, the neighbours green).
  Diagnosis path: `actions_list` the workflow's recent `main` runs — intermittent
  red/green there ⇒ flaky, not yours. (Sibling of §19: verify a red check is *real*
  before acting on it. Note the integration token here lacked `rerun-failed-jobs`
  permission, so re-running to confirm flakiness wasn't available — the main-history
  check is the fallback.)

- **`conformance-full`'s behavioral `test e2e` tier only exercises the backends the
  `.ddd` actually targets — in `showcase.ddd` that's dotnet + hono + one UI, NOT
  elixir/python/java — so an elixir-only change cannot cause its DSL-e2e failure.**
  A nightly `Conformance full` went red in the "generated DSL-level e2e suite runs
  against the live system" sub-test (the child `npx vitest run` in `<out>/e2e` exited
  1), on a commit whose only changes were elixir codegen. Exoneration was structural,
  not statistical: `grep 'test e2e .* against' examples/showcase.ddd` shows every api
  block targets `honoApi` (8) / `dotnetApi` (5) / `consoleWeb` (1) and **zero** target
  `phoenixApi` — the elixir backend is built + booted (it rides the `/health` + 5-way
  OpenAPI parity checks, which passed) but no behavioral test runs against it. So the
  failing assertion hits dotnet or hono; an elixir diff is not in its runtime path.
  Diagnosis path for any red conformance behavioral sub-test: read the `against
  <deployable>` targets of the source system *first* — if your change's backend isn't
  among them, it's exonerated before you even read the assertion. (This is the same
  structural blind spot that let the `#1796` elixir op-persist bug ship uncaught: "no
  per-PR gate does an elixir *operation* round-trip" — the conformance behavioral tier
  doesn't either, because `showcase.ddd` points its op-exercising e2e at dotnet/hono.)

  Re-triggering it via the `run-conformance` label on a docs-only PR **reproduced**
  the failure identically — so it is NOT a flake but a real `main`-red: every request
  in the generated api harness returns **`401 Unauthorized` across all five backends**
  (`:3000` hono, `:8000` python, `:8080` dotnet, `:8081` java, `:4000` phoenix), so the
  expected `422`/`404` assertions never reach their path. The standalone `Hono OIDC
  auth (runtime e2e)` gate is green, so auth *codegen* works in isolation — the break
  is the conformance multi-backend keycloak setup / harness token (candidate: the
  bundled-Keycloak realm-key rotation gotcha above, or api-e2e token acquisition). The
  docs-PR-reproduces + all-backends-uniform combo is the tell that it's harness/infra,
  not any one backend's codegen.

## 22. Landing a breaking validation change — census first, and mind the two blind spots (2026-07-12)

Shipping `loom.effect-in-lambda` (effects must be named actions) and flipping
`loom.missing-effect-marker` warning→error (async Stage 2b) both went clean
because of one discipline and two blind spots that bit / nearly bit.

- **Census before you flip.** Before adding or flipping a validator that rejects
  previously-valid `.ddd`, run `validateLoomModel` over **every git-tracked
  `.ddd`** (`git ls-files "*.ddd"`, parse standalone on `EmptyFileSystem`, skip
  AST-error fragments) and count the diagnostic's sites. **Zero sites = safe to
  flip, no codemod needed** — both changes had 0 corpus sites, so "ship a
  codemod first" was moot. Caveat: the standalone-parse census **undercounts**
  multi-file systems (a file that's a fragment alone but complete via an import
  graph is skipped), so pair it with green *real-generate* CI, which builds the
  actual import graphs. Census + green CI together is airtight; neither alone is.

- **Blind spot 1 — e2e fixtures are NOT in `npm test`.** Docker-only build
  checks (`vanilla-page-stmts`, the react/svelte/vue build matrices) generate
  from `test/e2e/fixtures/*.ddd` (and `examples/`) via the CLI, which runs
  `validateLoomModel` and `process.exit(1)`s on error. A validation change can be
  **green on the 6756-test fast suite and still redden CI** — `effect-in-lambda`
  did exactly that (`vanilla-page-stmts.ddd` used inline `onClick: e => { count
  += 1 }`). Census/grep `test/e2e/fixtures/` too, and run the targeted gate
  locally (`LOOM_PHOENIX_VANILLA_BUILD_CASE=<f>.ddd npx vitest run
  test/e2e/generated-elixir-vanilla-build.test.ts`) before pushing.

- **Blind spot 2 — generator tests BYPASS `validateLoomModel`.** `test/generator/**`
  lower+generate directly (`generateSystemFiles`/`toLoomModel`), skipping IR
  validation. So an **over-broad IR-validate check passes the whole suite yet
  breaks real generation**: `effect-in-lambda` flagged extern-component
  `action(Order)`-param lambdas (a deliberate Tier-2 feature) and the ~7000-test
  suite missed it — only a CLI `generate` or a `validateLoomModel`-path unit test
  caught it. **A new IR-validate check needs a `validateLoomModel`-path test, not
  generator coverage.**

## 23. Feliz F# wire layer — F# offside vs the walker's line-1-only re-indent (2026-07-12)

Landing the Feliz frontend's **wire layer** (Thoth decoders + a `Cmd`-based
`Api` module + the MVU `Remote<'T>` projection for `<param>.<agg>.all` reads,
slice 7 of `docs/plans/feliz-frontend-build.md`) turned up one load-bearing
gotcha that dictated the whole design.

- **The shared `walkBody` re-indents only a child's FIRST line.** Children are
  joined with `\n<indent>` and the pack prefixes the *block* with `indent`
  once, so a multi-line child keeps the walker's inconsistent internal columns.
  For the JSX/markup frontends this is invisible (JSX ignores whitespace). Feliz
  is the first frontend whose embedded language is **offside-sensitive**, so any
  multi-line `match` / `if…then…else` / `yield!` spliced into a Feliz `[ … ]`
  children list is *offside of the list context* and fails `dotnet fable`
  (`error FS0058: … token is offside of context started at …`). Inside plain
  `[ … ]` brackets F# is lenient (arbitrary element indentation is fine — that's
  why the Counter's nested `Html.div [ … ]` tree compiled); the offside rule
  only bites once an offside-*keyword* (`match`/`if`/`yield!`) opens a context.

- **Two fixes, both verified by Fable compile before shipping the emitter:**
  1. **QueryView → an emitted `View.remoteList` helper**, not an inline `match`.
     A helper *call* `View.remoteList model.X (loading) (error) (empty) (fun rows
     -> <data>)` is offside-safe because everything up to the trailing lambda is
     ONE line and the multi-line `data` body lives inside the `(fun … )` paren
     (bracket-lenient). The `match` itself sits in a top-level `module View`
     def I indent correctly. `For` → `yield! coll |> List.map (fun x -> body)`
     works spliced into `prop.children [ … ]` for the same reason (its body is a
     bracket-delimited `Html.x [ … ]`).
  2. **`renderConditionalChild` / `renderMatch*` emit SINGLE-LINE
     `if/elif/else`.** A one-line expression can't be offside of anything. Safe
     to flatten the walked arm markup to one line (`\s*\n\s*` → ` `) because
     Feliz emits **block** comments (`(* … *)`, never `//`, so no EOL-comment
     swallow) and F#-source newlines here are all structural (string-literal
     newlines are the two-char escape `\n`). The first cut emitted a multi-line
     `(if c then\n  a\n else\n  b)` and it Fable-*failed* exactly as above — the
     one-line rewrite fixed it.

- **F# record fields keep the EXACT wire-shape names (lowercase as written).**
  The shared `member` arm renders `p.name` verbatim (no casing seam), and Thoth
  `Decode.field "name"` maps the JSON key straight onto a lowercase F# record
  field — so decoders, records, and page-body member access all line up with
  zero casing translation. Don't Pascal-case them "to look idiomatic"; it
  reintroduces a seam the walker doesn't have.

- **Prove-it discipline paid off twice.** Both offside failures were caught by a
  10-second `dotnet fable` in the SDK:8.0 container against the REAL generated
  project (not a hand-written sketch) *before* the emitter shipped — exactly the
  "prove it or don't ship it" loop the plan calls for. A generator-only test
  would have gone green on both broken versions (it never compiles F#).
