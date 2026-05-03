# Loom — Experience Gathered

Lessons captured while bootstrapping the Loom DDD DSL (Langium → Loom IR →
Handlebars → TypeScript / .NET). Written for whoever picks this up next.

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
