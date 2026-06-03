# Retrieval — implementation plan (PR-sliced)

> Status: **plan, not yet implemented.** Captures the grounded
> file-by-file plan for the `retrieval` keyword
> ([`../proposals/retrieval.md`](../proposals/retrieval.md)). Companion:
> [`../proposals/reified-criteria.md`](../proposals/reified-criteria.md)
> (the `RetrievalIR` / `LoadPlanIR` / `CriterionRefIR` seam) and the
> shipped [`../criterion.md`](../criterion.md).

## The one correction to the mental model

`retrieval` is **not** "compose existing pieces." A codebase sweep
confirms that **none** of these exist today and the feature builds them:

- **No `sort` / `orderBy`** anywhere (grammar, IR, or any backend).
  Repository `find` is `find <name>(<params>): <Return> where <expr>`
  only — no ordering/paging/loads clauses despite what `criterion.md`'s
  "extended find" section imagines.
- **No `Repo.findAll` builtin machinery.** Repositories expose
  author-declared finds + the enrichment auto-`findAll`. `Repo.run` is
  entirely new repo-builtin-call machinery.
- **No `loads` / LoadPlanIR.** `load-specifications.md` is unimplemented;
  `LoadPlanIR` is greenfield.
- **Criteria are inlined.** `lowerCriterionReference` substitutes the
  body; `CriterionRefIR` does not exist. `retrieval` is intended to be
  the **first consumer** of a reified criterion reference.

So budget for building sort + loads + pagination + a repo-builtin + the
reified ref — not just a new declaration.

## PR slicing (each keeps `npm test` green)

Too big for one PR. Mirror how #765 landed ("surface + IR + validation,
no emission" — CI-safe because nothing consumes the new IR yet).

1. **PR1 — surface + IR + lowering** (no backend emission; CI-safe). ✅ **MERGED** (#794).
2. **PR2 — validation** (selectability, sort/path checks). ✅ **MERGED** (#794).
3. **PR3-A — `run<Name>` repository method emission (Hono/Drizzle)** + `LOOM_TS_BUILD` gate. ✅ **DONE** (PR #800). The method exists + tsc-compiles; not yet callable from a workflow.
4. **PR3-B — workflow `for` loop + `Repo.run` call wiring + save-model reshape (Hono)**. ✅ **DONE** (this branch). Grammar `ForStmt` (+ block-safe `ForIterable`), IR `repo-run` / `for-each` variants + `savesPerIteration`, `computeSaves` extraction, validator (array-binding iteration + retrieval/target checks), Hono `for…of` + per-iteration save. **.NET and Phoenix gate `repo-run`/`for-each` with an explicit "not yet supported" throw** — they need their own run-method emission (.NET) and the `Enum.reduce_while` reshape (Phoenix). Full `Repo.run` + loop tsc-compiles on Hono.
5. **PR3-C — .NET `Run<Name>Async` emission + `foreach`**. ✅ **MERGED** (#810). `buildRetrievalBodies` → `.Where(x=>…).OrderBy[Descending](x=>x.Col).AsQueryable()` + conditional `Skip`/`Take` from a `(int? offset, int? limit)? page` arg; workflow `repo-run`→`Run<Name>Async(args, (off,lim), ct)`, `for-each`→`foreach` + per-iteration `SaveAsync`. Document-shaped aggregates skip retrievals in v1. Exercised by the `sales.ddd` `verifyByName` workflow under the `dotnet-build` + `hono-build` gates.
6. **PR3-D-1 — Phoenix retrieval read action** (Ash `read :<name>` with `^arg` filter + `prepare build(sort:)` + offset `pagination`, `run_<name>_<agg>` code-interface define) + `phoenix-build` gate. ✅ **MERGED** — opened as #811, shipped folded into the combined **#820** (PR3-D-1 + PR3-D-2); #811 closed unmerged with its work in main. Adds a `filterArgs` render mode (`param` → `^arg(:name)`) + per-type Ash arg mapping.
7. **PR3-D-2 — Phoenix `Enum.reduce_while` workflow loop**. ✅ **DONE** (this branch). New `stmt`/`loop` `WorkflowBodyLine` kinds + a sequenced-body branch in `renderTransactional/SequentialBody` (the `with`-chain can't host a loop); `repo-run` → `run_<ret>_<agg>!(args, page: […])` (bang variant returns the page struct, raises → tx rollback); `for-each` → `Enum.reduce_while(<iterable>.results, {:ok, nil}, fn …)` with body op-calls in `case … {:cont}/{:halt}` form. Iterates `.results` (offset pagination returns `%Ash.Page.Offset{}`). roster.ddd fixture gains a `verifyByName` loop workflow for the `mix compile` gate. **Retrieval now ships on all three backends.**
8. **PR4 — explicit `loads` / LoadPlanIR fetch realisation + loads-sufficiency** (the actual eager-fetch wiring; backends honoured `whole` as a no-op until here).
   - **The parity invariant that shaped this — and why explicit `loads:` is now gated.** A retrieval must return the **same wire shape** from every backend (the conformance parity gate). Owned containments are part of an aggregate's `wireShape`, so an explicit `loads:` can **never** narrow them out on an aggregate-shaped backend — dropping a part on one backend would diverge it from the others. So narrowing is a no-op on Hono and .NET (both always materialise the whole aggregate), and observable only on Phoenix, whose *relational* containments are separate `has_many`s outside the Jason wire shape. Honouring a knob on one backend and silently ignoring it on two is a footgun, so **explicit `loads:` is rejected at IR validation** (`loom` retrieval check in `validate.ts` — *"explicit 'loads:' is not supported yet"*): **every retrieval loads the whole aggregate**, uniformly, on all three backends. The grammar/IR/lowering for `loads:` stays (forward-compat), but no `.ddd` may carry a narrowing clause yet.
   - **Decision: whole-only now, per-operation autoload later.** The planned replacement is *autoload* — derive each operation's load set from the expressions its body uses, and a retrieval's plan from the union of the operations its `for`-loop consumers invoke. That makes the load shape **sufficient by construction**, which **obviates the entire `operation loads` clause + `loom.loads-incomplete` + `loom.retrieval-loads-insufficient` machinery** from `load-specifications.md` (you generate the right plan instead of validating a hand-written one). Autoload also subsumes the deferred cross-aggregate eager-fetch (`self.lines[].product` → fetch the referenced aggregate). Until it lands, whole is the conservative-but-correct default.
   - **PR4-Phoenix — Ash `load` realisation.** ✅ **DONE** (#850, gated whole-only on this branch). The retrieval read action emits `prepare build(load: [:rel, …])` loading **every owned containment relationship** (`has_many`/`has_one`) so a downstream `for`-loop operation can read `record.<part>` without a `%NotLoaded{}` crash. Whole-only: `retrievalLoadAtoms(agg)` is a pure function of the aggregate (no `loadPlan` inspection — narrowing is gated upstream). Cross-aggregate refs (`X id` → `many_to_many`) stay ids and are never loaded; `embedded`/`document` aggregates fold parts inline and emit no `load`. Ash realises `load` as a separate batched query per relationship, so it composes with the action's offset pagination without the in-memory collection-paging penalty an ORM join-fetch hits (`renderRetrievalAction` / `retrievalLoadAtoms` in `repository-emit.ts`). roster.ddd gains a `contains badges` containment so `ByName`'s whole-load compiles `prepare build(load: [:badges])` under the `mix compile` gate.
   - **PR4-EF — owned-types no-op (verified).** ✅ **DONE** (#850). On .NET, owned containments map to `OwnsOne`/`OwnsMany` (efcore.ts) and EF Core **always** materialises owned types with their owner — there is no `.Include` step to gate and an owned navigation can't be projected away, so `whole(T)` is satisfied for free and an explicit `loads:` neither widens nor narrows the query. Documented at the `Run<Name>Async` emit site (repository.ts) and pinned by a regression guard (`retrieval-emit.test.ts`): a whole and an explicit-`loads` retrieval emit the **byte-identical** query body (no `.Include`, no narrowing), and the containments are confirmed `OwnsMany`. (Loom has no relational/non-owned child model on .NET — containments are owned by construction — so there is no further EF wiring to do.)
   - **PR4-Drizzle — bulk-load no-op (verified).** ✅ **DONE** (#862). On Hono, `runMethod` (`repository-find-builder.ts`) already bulk-loads every owned containment via `eagerContainsOf` and the hydrate folds them all into the returned aggregate, so `whole(T)` is satisfied and `loads:` narrowing is a no-op by the parity invariant above (same as EF). Documented at the emit site and pinned by a regression guard (`typescript/retrieval-emit.test.ts`): a whole and an explicit-`loads` retrieval emit the structurally identical method body, and the explicit one still bulk-loads the non-listed containment. **All three backends now load whole, uniformly; explicit `loads:` is gated at IR validation (`loom.retrieval-loads-unsupported`); the `loom.retrieval-loads-insufficient` validator is obviated by the planned autoload (sufficient by construction). v1 `loads` work is closed.**

### Next phases (post-PR4 roadmap)

On review, **retrieval is feature-complete**: `where` (composed criteria + the queryable subset), multi-column `sort` on real columns, offset pagination, and whole-load all ship across the three backends. What's left is either explicitly **declined** (below) or one of two open threads — **reified criteria → `Specification<T>`** (Phase 5, architectural, the higher-priority one) and **autoload** (Phase 6, low-urgency). Grounded in `docs/proposals/load-specifications.md` + `docs/proposals/reified-criteria.md` + `docs/proposals/java-backend.md`.

**Considered & declined** (recorded so they don't get re-proposed):

  - **Projection / `select` — declined; already served by `view`.** The *width* axis (return a narrowed/transformed field set, distinct from `loads`' *depth* axis) is Loom's full-form **`view`**: `view OrderSummary { … from Order where … bind … }` declares a projected output shape, bind-projected per row, parity-safe, emitted as `GET /views/<name>` (see `docs/views.md`). A retrieval-level `select:` would duplicate it — retrievals deliberately return the *whole* aggregate because their `Repo.run`/for-loop consumers mutate it. The one true seam, **parameterised** projection (views are parameterless), `views.md` files as a future "views earn parameters" item — a views concern, not a retrieval one.
  - **Nested-path sort — declined.** Multi-column sort over real columns already works; *nested* paths don't survive scrutiny. Cross-aggregate (`sort: [customer.name]`) needs a join across an aggregate boundary (possibly across contexts/databases) — the same rule that keeps cross-aggregate refs as ids makes it a **non-goal**. Value-object sub-fields (`address.city`) are niche and usually flattened to a directly-nameable column. Containment aggregates (`lines.count`) are already expressible as a `derived` column you then sort on. No real gap.

**Phase 5 — Reified criteria (`Criterion<T>` standalone, `Specification<T>` for queries) (architectural; the higher-priority thread).** Today criteria are *inlined* — a `criterion` body is substituted into each use-site's `ExprIR`, and thus into every backend's LINQ / SQL / Drizzle / Ash predicate. `CriterionIR` exists in the IR but **no backend consumes it**. The reified direction (`docs/proposals/reified-criteria.md`, sibling `docs/proposals/java-backend.md`) reverses that: backends consume `CriterionIR` directly and emit a **constructed predicate object** — the Evans / Spring-Data `Specification<T>` pattern made real in generated code instead of dissolved at compile time.

  - **`Criterion<T>` is independently useful — *not* gated on retrieval.** A `criterion` appears across the whole boolean-expression footprint (`criterion.md`), most of which has nothing to do with queries: **invariants**, **operation preconditions / `when` guards**, repository **`find … where`**, **`view … where`**, capability **`filter`** (contextFilters → `HasQueryFilter` / Ash `base_filter`), and — one consumer among many — **retrieval `where`**. Criteria also compose other criteria (`criterion C = A && B`). So a reified `Criterion<T>` pays off even if `Specification<T>`/retrieval-reification never happens — the bulk of criterion use is validation + gates + filters.
  - **Two faces, both of which Ardalis `Specification<T>` already provides:**
    - **`IsSatisfiedBy(entity)`** — in-memory evaluation → **invariants, preconditions, guards** (the domain-logic face; no DB). This is Evans's original `Specification.isSatisfiedBy(T)`.
    - **`ToExpression()` / `SpecificationEvaluator`** → `Query.Where(...)` over EF Core `IQueryable` → **find / view / capability filter / retrieval** (the query face).
  - **The layering** (this is the `Criterion<T>` ⊂ `Specification<T>` relationship):
    - **`Criterion<T>`** = the reified predicate (`where` only), used **everywhere**. The foundational reification.
    - the **query bundle** = `Criterion<T>` (the `where`) + `sort` (`.OrderBy`/`.ThenBy[Descending]`) + `page` (`.Skip`/`.Take`) + `includes` (`.Include`, a no-op given owned types — see PR4). On **Ardalis (.NET)** this whole bundle **is** `Specification<T>`, so a **`retrieval` (or `find`) renders to a `Specification<T>`** consumed via `_repo.WithSpecification(spec)`, while a bare **criterion** is only its `Expression<Func<T,bool>>` (the `.Where(...)` contribution). **Heads-up — Spring splits it the other way:** Spring's `Specification<T>` is *predicate-only* (= the **criterion**), and the bundle is `findAll(spec, Pageable)` (sort/page via `Pageable`). So the *same library name* sits at the **criterion** layer in Spring but the **retrieval** layer in Ardalis. An **invariant / precondition** uses only the `Criterion<T>` (predicate) face on every backend.
  - **`CriterionIR` and `RetrievalIR` are the shared abstractions — the framework type is a *rendering target*, never the shared concept.** (The Ardalis-vs-Spring `Specification<T>` mismatch above proves it; so does Dapper.) Each backend renders **both** nodes to its native shapes:
    - a **criterion** (predicate) → EF `Expression<Func<T,bool>>` · **Dapper** a parameterized SQL `WHERE` fragment + param object (`emit/dapper.ts:whereToSql(ExprIR)` — already exists, inlined per-find today; reify = *named* fragment producers + a param-merge scheme for `A && B`) · Hono a Drizzle predicate closure · Ash an `Ash.Query` filter fragment · Spring a (predicate-only) `Specification<T>`.
    - a **retrieval** (criterion + sort + page + loads) → EF/Ardalis `Specification<T>` (`.WithSpecification`) · Dapper a full SQL builder (`WHERE` + `ORDER BY` + `LIMIT/OFFSET`) · Hono / Ash a query-builder method / read action · Spring `findAll(spec, Pageable)`.
    Centering the design on Ardalis `Specification<T>` would make Dapper/Hono/Ash — and even Spring — awkward exceptions; centering on `CriterionIR`/`RetrievalIR` + per-backend renderers is just Loom's existing platform-neutral-IR + per-backend-emitter architecture. **Dapper specifically:** no `IQueryable`/expression translation, so the EF `Specification<T>`/`SpecificationEvaluator` machinery can't carry — but the SQL-fragment renderer is already in `whereToSql`; the only genuinely new work is fragment *composition* (merging params when `A && B` both bind, say, `@region`).
  - **The two faces split cleanly along the persistence seam.** The **evaluate face (`IsSatisfiedBy`)** is persistence-*agnostic* — it lives in the generated **Domain layer**, which #855 keeps identical across EF Core and Dapper. So a reified criterion's invariant/precondition face is written **once** and reused by every .NET persistence backend. Only the **query face** diverges per renderer (EF Expression vs Dapper SQL). This is why the recommended sequence is evaluate-face-first: that slice is backend-agnostic and lands the bulk of the value with zero per-persistence cost.
  - **Selectability decides which face a criterion needs.** A criterion in a *query* position must stay in the **queryable subset** (EF-translatable `Expression<Func<T,bool>>` — Loom already enforces `loom.criterion-not-queryable`); one used only in *evaluate* positions can be richer (it runs in-memory). A reified `Criterion<T>` always carries `IsSatisfiedBy`; selectable ones additionally carry `ToExpression()`. This maps onto Loom's existing selectable-vs-ambient distinction — no new model.
  - **The three pieces** (`reified-criteria.md`): the **spec** (pure value object, no ambient access), the **factory** (the *one* place request-scoped deps like `currentUser` are read + bound — dissolving the "find filters thread `currentUser` as a param, capability filters read it from an accessor" duplication), the **consumer** (applies the spec, knows nothing about principals).
  - **Prefer Loom-owned `Criterion<T>` / `Retrieval<T>` types over framework idioms — especially on Java.** Because `Specification` / `Criteria` are overloaded and *backwards* across frameworks (Ardalis `Specification<T>` = the whole query / **retrieval**; Spring `Specification<T>` = predicate-only / **criterion**; JPA `Criteria*` = a query-*builder*, not a predicate — recorded in `experience_gathered.md` → "The 'Specification' / 'Criteria' naming quirk"), generated code should emit **Loom's own** `Criterion<T>` (predicate) and `Retrieval<T>` (query bundle) and keep the framework types as *internal rendering details*. On **Java** that means a custom `Retrieval<T>` — bundling `Criterion<T>` + sort + page + loads, à la Ardalis's all-in-one spec — executed by the repository, rather than scattering the bundle across `findAll(spec, Pageable)` and leaning on Spring's confusingly-layered `Specification`. Same on .NET: a Loom `Retrieval<T>` can wrap (or replace) the Ardalis `Specification<T>`. Payoff — **one consistent abstraction *shape* (Loom names) across backends**, each rendered to its idiom underneath; the reader never has to know which framework's "Specification" they're looking at.
  - **The reified shape is the SOLID-correct one; today's inline + per-retrieval-method design is the smell.** Each retrieval currently *adds a `run<Name>` method to the repository* and inlines its predicate — violating **OCP** (a new query edits the repository), **SRP** (the repo accretes every query + execution), and **DIP** (handlers depend on concrete inlined predicates). Reifying inverts it: the repository exposes a *generic* `run(retrieval: Retrieval<T>)` / `evaluate(criterion: Criterion<T>)`, **closed to modification but open to new `Criterion`/`Retrieval` types** (OCP); each type has one job — predicate / bundle / execution (SRP); consumers depend on the abstraction (DIP); and the two-faces split *is* **ISP** — an invariant depends only on `IsSatisfiedBy`, never the sort/page/query surface. The *shape* stays per-backend-idiomatic: typed objects on .NET/Java, **composable closures on Hono** (a `Criterion` is `(args) => predicate`, a `Retrieval` a value the repo runs — the functional analog of the same SOLID, no class hierarchy), query fragments on Ash. So the current Hono per-retrieval `run<Name>` method is "ok-ish" but is exactly the OCP edit-the-repo smell — a generic `run(retrieval)` over composable predicate functions is the fix *without* forcing un-idiomatic OO onto a functional backend.
  - **Why it's the priority thread:** the inline model accreted those `currentUser`-two-ways special cases, and `reified-criteria.md` notes #767 is where it "visibly cracks." Reifying unifies invariant + precondition + `find` + `view` + capability `filter` + `retrieval` onto one `Criterion<T>`/`Specification<T>` surface and makes `CriterionIR` the artifact backends actually consume. It's also the enabling step for `java-backend.md`'s headline Spring `Specification<T>` differentiator (the first backend to consume `CriterionIR` directly).
  - **Sequencing — evaluate-face-first.** `IsSatisfiedBy` (invariants / preconditions) needs no expression-tree translation, so it's the simplest first slice and touches no query code; add `ToExpression()` for the query positions (find / view / capability filter) next; wrap into a full `Specification<T>` for `retrieval` last. Additive per backend (new emitted types — no flag day), so one backend (Java green-field, or .NET where `Specification<T>` + `.WithSpecification` is idiomatic) can adopt it while others keep the inline output. On .NET this turns the current **EF Core + inline LINQ** into **EF Core + `Criterion<T>`/`Specification<T>`** — same shape as Spring `Specification<T>`.

**Phase 6 — Autoload (auto-inference) — low-urgency, deferred.** The eventual direction *if* minimal loads ever matter: derive each operation's load requirement from the expressions its body uses, and a retrieval's plan from the union of the operations its `for`-loop consumers invoke — making the load shape **sufficient by construction**, which *obviates* the `operation loads` clause + `loom.loads-incomplete` + `loom.retrieval-loads-insufficient` machinery from the original proposal (generate the plan instead of validating a written one). It's low-urgency for three reasons:

  - **Within the aggregate boundary** (owned containments), whole-load already covers every case conservatively and parity-safely. Autoload would only trim already-cheap intra-row loads — little payoff.
  - **Across the boundary** (referenced aggregates — `order.customer`, `lines[].product`), the read-batching mechanism **already ships, in `view`** (slice 3): the lowering collects `(sourceField, targetAgg)` `auxiliaries`, each referenced aggregate's repo exposes `findManyByIds` / `FindManyByIdsAsync`, and the handler bulk-loads into id→entity maps — **one query per referenced aggregate regardless of row count (anti-N+1)**, multi-hop chains included. Views are the natural home for cross-aggregate reads.
  - **The aggregate-boundary worry is about *writes*, not *reads*.** "One aggregate per transaction" constrains atomic *mutation* across aggregates (use domain events / eventual consistency), not *reading* related aggregates. So a workflow batch-reading referenced aggregates is boundary-safe — pure anti-N+1, the same thing views do. The real violation is pre-fetch-**then-write** across aggregates in one transaction (a saga/events concern, unrelated to the fetch). The genuine risk is *ergonomic*: making cross-aggregate traversal frictionless in operation bodies invites domain decisions / invariants based on another aggregate's (possibly stale) state, quietly blurring the boundary — so cross-aggregate reads should stay **explicit and read-only**, never silently autoloaded.

  **Decision: defer.** No workflow today needs an in-loop cross-aggregate read, and views cover cross-aggregate reads cleanly. Revisit only when a concrete workflow forces it — and even then, prefer an **explicit** batched read (reusing the view `auxiliaries` mechanism) over autoload-magic, to keep the boundary crossing visible. If pursued, the inference sub-steps are: operation body-walk → load-requirement derivation (the walk a `loom.loads-incomplete` validator would have needed — inference replaces the validator); retrieval plan synthesis from `for`-loop consumers (interprocedural — start non-recursive; call-graph fixpoint / recursion / polymorphic ops over inherited aggregates later); and shape typing + `is loaded` guard narrowing (defer further — occurrence-typing for a small ergonomic win).

### PR3 grounding (what the `Repo.run` lowering must reuse)

- **Repo-call recognition already exists**: `matchRepoCall`
  (`lower.ts:2446`) recognises `<Repo>.<method>(args)` postfix chains in
  workflow bodies and resolves the repository.  `Repo.run` is a new
  `method` value handled alongside `getById` / `findAll`; the **first
  arg is a retrieval reference** (`ActiveInRegion(region)`) and an
  **optional trailing `page:` named arg** — so `matchRepoCall` (or its
  caller around `lower.ts:2284`) needs to special-case `run` to pull the
  retrieval name + its args + the page arg, rather than treating them as
  plain positional find args.
- **CallKind**: add a `repo-run` discriminator (`CallKind`,
  `loom-ir.ts:1776`) so the Hono builder can dispatch.
- **Hono emission**: model the `run<Name>` method on `findQueryMethod`
  (`repository-find-builder.ts`) — `where` → `lowerToDrizzle`; `sort` →
  `.orderBy(asc/desc(col))` (add `asc`/`desc` to the drizzle import set
  the way #760 added `not`); `page` (from the run call) →
  `.limit().offset()`; `whole` loadPlan → reuse the existing
  containment bulk-load (`bulkLoadContainmentLines`).  Explicit `loads`
  shapes stay deferred to PR6 (PR3 honours `whole` only).
- **Note**: PR1 lowered the retrieval `where` as a plain inlined
  `ExprIR` (criterion composition already inlines at lower-expr), *not*
  a `CriterionRefIR`.  That keeps PR3 simple — the Hono builder feeds
  `where` straight into `lowerToDrizzle`, exactly like a find filter.
  The `CriterionRefIR` reification (reified-criteria.md) is a later,
  separate refactor and is **not** a prerequisite for retrieval shipping.

---

## PR1 — Grammar + parse + IR + lowering

### Grammar — `src/language/ddd.langium`

- Register `Retrieval` in the `ContextMember` alternation (~line 611,
  next to `Criterion`).
- Add the `Retrieval` rule after `Criterion` (~line 888). Model on
  `Criterion`:
  ```
  Criterion:
    'criterion' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? 'of' target=TypeRef
    ('=' body=Expr | '{' 'where' ':' body=Expr '}');
  ```
  Retrieval adds two optional ordered slots after `where`:
  ```
  Retrieval:
    'retrieval' name=ID ('(' (params+=Parameter (',' params+=Parameter)*)? ')')? 'of' target=TypeRef
    ( '=' where=Expr
    | '{' 'where' ':' where=Expr
          ('sort'  ':' '[' (sort+=SortItem  (',' sort+=SortItem)*)?  ']')?
          ('loads' ':' '[' (loads+=PathExpr (',' loads+=PathExpr)*)? ']')?
      '}' );
  ```
  Plus `SortItem` (path + direction discriminator field — **not** an
  `{infer}` action, per CLAUDE.md), and a lightweight structural
  `PathExpr` (`head=ID ('.' seg)*` with a `[]` collection marker) — do
  **not** reuse `Expr` for paths (load-specifications.md: "just
  structural paths"). Use flat-list rules, discriminator fields.
- `npm run langium:generate` then `npm run build`; verify the
  `langium-generated.yml` determinism gate (committed parser matches).

### IR types — `src/ir/types/loom-ir.ts`

After `CriterionIR` (~line 546) add: `CriterionRefIR { criterionName,
args }`, `SortTermIR { path[], direction }`, `LoadPlanIR { kind:
"whole"|"explicit", paths? }`, `RetrievalIR { name, params, targetType,
where, sort?, loadPlan }` — **no `page` field** (page is a call-site arg
on `Repo.run`). Add `retrievals: RetrievalIR[]` to `BoundedContextIR`
(next to `criteria`, ~line 564). Add a `callKind` value (`"repo-run"`)
for the run builtin call.

### Lowering — `src/ir/lower/lower.ts` + `lower-expr.ts`

- `lowerRetrieval(r, env): RetrievalIR` — model on `lowerCriterion`
  (~line 1306). Bind `self` to the `of <T>` candidate exactly as the
  criterion lowerer does. Lower `where` via the expression lowerer;
  build `CriterionRefIR` for direct criterion references (the
  reified-seam goal), inline-lower bare predicates. Lower `sort` paths;
  `LoadPlanIR` = `{kind:"whole"}` when no `loads:`, else
  `{kind:"explicit", paths}`.
- Collect retrievals in the context lowering where
  `criteria.push(lowerCriterion(...))` is (~line 1278); include
  `retrievals` in the returned `BoundedContextIR` (~line 1295).
- `lower-expr.ts`: lower `Repo.run(Retrieval(args), page?)` — find where
  repo method calls (`Customers.getById(...)`) lower; add `.run(...)`
  recognition producing a CallIR with the `repo-run` callKind carrying
  `{ repoName, retrievalName, args, page? }`.

### Tests

- `test/language/retrieval-parse.test.ts` — single-line form; full block
  (3 slots); `where`-only block; params; `of <Aggregate>`.
- `test/ir/retrieval.test.ts` — parse→lower: `RetrievalIR` shape,
  `LoadPlanIR` default `whole`, sort terms, `CriterionRefIR` in `where`,
  the run-call CallIR.

---

## PR2 — Validation (`src/language/validators/retrieval.ts`, model on `criterion.ts`)

- `where` selectability: reuse the `firstNonQueryableNode` oracle (the
  one #760 wired for contextFilters). `loom.criterion-not-selectable`.
- sort fields exist on T: `loom.invalid-sort-field`.
- loads paths exist: `loom.invalid-path`.
- cross-candidate composition in `where` already forbidden by the
  criterion validator — route the retrieval `where` through it.
- `loom.retrieval-loads-insufficient` at `Repo.run` consumers
  (`src/ir/validate/validate.ts`) — can defer with PR6.
- Negatives in `test/language/validation/retrieval-validator.test.ts`.

---

## PR3–PR5 — Backends (one at a time; closest precedent = the just-merged contextFilters #760/#762 + existing `findQueryMethod`)

- **Hono first** (`repository-find-builder.ts` `findQueryMethod` +
  `lowerToDrizzle`; `repository-builder.ts`): emit `run<Name>` method —
  `where`→`lowerToDrizzle`; `sort`→`.orderBy(asc/desc(col))` (add
  `asc`/`desc` to the drizzle import set, the way #760 added `not`);
  `page`→`.limit().offset()`; `whole` loadPlan→reuse
  `bulkLoadContainmentLines` (#745). Run-call renders to
  `repo.run<Name>(args, page)`.
- **.NET** (`find-emit.ts` `buildFindBodies` + `emit/repository.ts`):
  `IQueryable` method — `where` via LINQ render, `sort`→
  `OrderBy/ThenBy[Descending]`, `page`→`Skip/Take`, `whole`→`Include`.
  (Ardalis `Specification<T>` framing is the Java-backend payoff,
  deferrable; direct `IQueryable` is fine for v1.)
- **Phoenix** (`repository-emit.ts`, per #762 `base_filter`): Ash read
  action — `where` as an Ash filter (**bare attribute names, no
  `record.` prefix** — the #762 gotcha), `sort`→Ash sort, `page`→Ash
  pagination, loads→Ash `load`.
- **React**: consumer only; relevant only if a `Repo.run`-using workflow
  is auto-exposed as an api route — confirm against api auto-exposure;
  likely defer for v1.
- Each backend: a `test/generator/<platform>/retrieval-emit.test.ts`,
  then the real build gate (`LOOM_TS_BUILD` / `dotnet-build` /
  `phoenix-build`). Add a `retrieval` + `Repo.run` to an example `.ddd`
  so the build-gate matrix exercises it (re-baselines byte fixtures via
  `scripts/capture-baseline-fixture.mjs`).

---

## Decisions already pinned (from the design thread)

- `Repo.run` (distinct builtin, **not** a `findAll` overload).
- `page` is **call-site only**; `where`/`sort`/`loads` are sealed by the
  declaration (open Q3 leaned "sealed").
- v1 `Repo.run` returns `T[]`; the paged carrier (`T page`) waits on
  `payload-transport-layer.md`.
- "Specification" never enters Loom source/IR names — backend-local only
  (see `reified-criteria.md` §Naming).

## Open decisions for the implementer

- Reify `where` now (build `CriterionRefIR`) vs inline-first. Recommend
  reify for direct criterion refs (the "prove the seam" goal), inline
  bare predicates.
- `Repo.run` machinery has no `Repo.findAll` precedent to copy — study
  the auto-`findAll` enrichment + `getById` call flow for the closest
  analog.
