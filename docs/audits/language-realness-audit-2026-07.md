# Is Loom a "real" language? — architecture-shortcut audit

*Snapshot: 2026-07-16, `main` @ (see git). Method: three parallel code-grounded audits (generators; IR/macros/grammar; cross-cutting debt + tests), each verified against source, followed by a deeper independent verification of the flagged points (§Deep verification). Question posed: is Loom a genuine, generic language compiler, or does it carry shortcuts / quick fixes / non-generic special-casing that will become painful as more features land?*

## Verdict

**Loom is a real, generically-engineered compiler — not a demo with shortcuts.** The pipeline is layered and test-enforced one-directionally; the cross-target codegen collapses onto genuine single-dispatch seams; unsupported (feature × backend) combinations fail *at validation* with a named `loom.*` code rather than crashing codegen or emitting silent-wrong output. The debt that exists is **localized, honestly registered in `docs/audits/` + `experience_gathered.md`, and mostly on the *product* side** (UI ceiling, data-migration story, security defaults) — not rot in the language machinery.

The one place the "add a feature → N compile errors until filled" safety net does **not** apply — persistence emission — was audited to conclusion in mission **M-T9.2** and found to be **irreducibly per-backend** (see §1). So the single biggest structural axis is *not* a fixable seam that was skipped; it is a genuine property of targeting five different ORMs.

## What makes it real (load-bearing, verified in code)

- **Exhaustive single-dispatch seams, actually implemented as leaf tables.** `src/generator/_expr/target.ts` owns one 17-arm `switch(e.kind)` with no `default`; each of the 5 backends supplies only a leaf table (`TS_TARGET`/`CS_TARGET`/`JAVA_TARGET`/`PY_TARGET`/`ELIXIR_TARGET`). CLAUDE.md's claim — "adding an `ExprIR.kind` = one arm + one interface method, and every backend is a compile error until filled" — is **literally true** (doubly enforced by the mirror `renderExprWithMarks`). Same pattern for `TypeTarget`, `WalkerTarget`, and the primitive registry (`_walker/registry.ts`, which explicitly replaced hand-coded switches).
- **Honest gaps, not silent ones.** 325 `loom.*` validator codes, ~50 of them target-restriction gates (`loom.event-sourcing-backend-unsupported`, `loom.tph-backend-unsupported`, `loom.<backend>-stamp-unsupported`, …), enforced by a "gated-XOR-emitted, never neither" meta-test (`test/platform/backend-parity-gates.test.ts`). The `stubAdapter` proxy that throws on unimplemented slots + validator-level rejection is genuinely well-designed.
- **Fully-resolved IR.** `ExprIR`/`RefKind`/`CallKind` are proper discriminated unions carrying `receiverType`/`memberType`/`callKind`; backends switch, never re-resolve. Macros are real AST→AST (typed-node factories, no string templating — `src/macros/api/factories.ts`); "derive don't stamp" is consciously applied (page-kind classified on demand via `classifyPage`, not stamped).
- **Behavioral tests, not snapshot theater.** 1,136 test files; correctness enforced by booted-stack tiers (generated backend on PGlite + real Postgres over HTTP), cross-backend wire-parity, and *executing the DSL-emitted test suites* — only ~8 `toMatchSnapshot` sites total.
- **Disciplined grammar.** `ddd.langium` comments show the recursive-AST / discriminator-over-`infer` / soft-keyword hazards were understood and avoided deliberately, not stumbled into.

## The debt that will actually bite (ranked)

### 1. Persistence emission has no shared seam — AND that is irreducible, not skipped

This is the widest axis (elixir 70 files / dotnet 61 / java 51 / python 37 / ts 32) and the one place adding a storage feature is genuine shotgun surgery, caught per-PR only by *compile* and otherwise by a *nightly* boot.

**Critical correction to the older recommendation.** `docs/audits/architecture-weak-spots-2026-07.md` §5 recommended building a `PersistenceTarget` seam "analogous to `ExprTarget`." The later, **concluded** mission `docs/new-plan/missions/M-T9.2-persistence-seam-design.md` audited all five backends at the byte level and **overturned that**:

> "regular-shaped" (conceptually parallel decision tree) is a strictly weaker property than "byte-identical-extractable" (shared composition API). Almost every persistence fragment is regular-shaped, but each ORM composes through a *different API* — Drizzle combinators, SQLAlchemy operator overloads, EF fluent config, JPA annotations, Ecto changesets — so the *composition* (the actual emitted bytes) diverges even where the decision tree is parallel.

The flagship candidate (`QueryTarget`, unifying `lowerToDrizzle` ↔ `lowerToSqlAlchemy` ↔ `renderJpqlWhere`) **declined**: Drizzle's `eq(col, val)` combinator must *split* operands by role, while SQLAlchemy's `(l op r)` operator-overload recurses both operands uniformly — a shared dispatcher cannot produce both byte-identically. Every `Target`-style candidate declined the same way. What actually landed: the **seed spine** (`groupByDataset`, the one composition-free fragment, #1876) + removal of the orphaned adapter emit-layer (closes M-T6.10). The genuinely shared substrate — `MigrationsIR`, `wireShape`, `sql-pg`, `ExprTarget`, `intrinsicKey`, deny/deep detection — was **already** extracted.

**The user's intuition is correct for the write path — with one nuance the deep re-audit surfaced (§Deep verification, point on persistence):**

- **Write / injection / embedded-mapping / DI / routes — a genuine hard wall.** The five backends compose writes on structurally foreign machines: Drizzle `insert…onConflict` + hand-emitted child diff-sync (~170 lines) ≈ SQLAlchemy mirror, but EF is `_db.Entry(...)` change-tracking (~5 lines, the tracker owns the diff), JPA is a `jpa.save(aggregate)` one-liner (Spring derives INSERT/UPDATE), Ecto is split `insert`/`update` verbs + changeset `{:ok,_}` tuples. Only the TS↔Python *pair* shares the tree. A shared string core would have to encode each framework's ordering/grouping — the pre-registered decline criterion. **This decline is right, and per-ecosystem drift is a stated *feature* (`src/platform/surface.ts` header), not debt.**
- **Query path (the flagship `QueryTarget`) — a *cost/benefit* decline, not an impossibility.** M-T9.2 §0.7 argues a shared dispatcher "cannot unify" Drizzle's operand-splitting `eq(col,val)` combinator with SQLAlchemy/JPQL's uniform-recurse `(l op r)` operators. Independent re-reading finds that argument **unsound**: it only defeats a *string-returning* dispatcher. An **AST/callback-returning** `QueryTarget<Q>` — exactly the mission's own §2.3.1 sketch (`compare(op,col,value)` / `boolColumn(col)` / `and`/`or`/`not` / `collectionContains` / `intrinsic` / `temporalArith` leaves) — absorbs that divergence as ordinary leaf-spelling, the way `ExprTarget` already does. The genuinely-parallel, currently-**triplicated** content is real: a ~9-arm queryable-subset walk plus the multi-clause deep-scope *composition*, hand-duplicated across TS/Py/Java. So `QueryTarget` *could* land and unify 3 backends; it's declined because (a) the detection/classification/intrinsic-key/bypass substrate is already shared, shrinking the novel surface, (b) it nets only 3 backends (.NET/Elixir already lower through `ExprTarget`), and (c) the `*_INTRINSIC_SQL` leaf tables stay per-backend regardless. That is a defensible judgment call, **revisitable under feature traffic** — not the hard wall the write path is.

**Net:** the "T10 freeze until a persistence seam exists" is effectively already lifted — a 6th backend inherits the shared substrate and hand-writes only the framework-native write/injection path it would have had to write regardless.

**Real residual cost:** not a missing abstraction, but that a relational storage feature still re-lands as ~1 leaf-edit per in-scope backend + a bespoke edit per decline-backend, and **runtime feedback is nightly, not per-PR**. The high-ROI mitigation is a per-PR boot gate, not a seam.

### 2. Per-backend validator gates are copy-pasted, not data-driven

`validateJavaStampSupport` / `validateDotnetStampSupport` / `validateNodeStampSupport` / … (`src/ir/validate/checks/system-checks.ts:982` vs `:1037`) are near-byte-identical except a platform-family string and a `loom.<backend>-stamp-unsupported` code suffix — ~250 lines that grow by one function per new backend. Same shape in `validateDapperSupport` / `validateMikroOrmSupport` / the containment-support family. The *gaps* are honest (a named validator code); the *expression* is a who-supports-what matrix hand-written as N copy-pasted functions instead of a data table. **Quick, safe win** (pure validation, no output change). *(Fixability re-checked in §Deep verification.)*

### 3. Authorization/tenancy threaded as sentinel `ExprIR`s that backends pattern-match

`writeScopeFilter`, `DEEP_SCOPE_MEMBER`, deny-filters (`src/ir/util/tenant-stance.ts`) are `ExprIR`s whose meaning is a sentinel every backend's filter translator must *recognize* (`isDenyFilter`/`isDeepScopeFilter`). This quietly violates the "backends never re-resolve" invariant *for authz specifically*. The sharpest middle-end smell; a new backend that forgets an arm silently mis-scopes. *(Justified-vs-fixable assessed in §Deep verification.)*

### 4. Import detection by regex-scanning already-emitted source text

Pervasive in the Python backend (~17 sites: `body.replace(/"…"/g,'""')` then `new RegExp('\\b'+name+'\\b').test(scan)`; `repository-port-builder.ts` even reconstructs `Protocol` signatures by regex-matching `async def` headers out of emitted text). Recovering structural info by re-parsing generated output is fragile and will mis-add/mis-drop imports as the type surface grows. The principled fix is a used-symbol set tracked during emission. **The one I'd fix before it metastasizes**, because it is silent-wrong rather than loud-fail. *(Concrete failure case in §Deep verification.)*

### 5. Two smaller, fixable ones

- **HEEx API-call routing coincidence** (`src/generator/elixir/heex-walker-core.ts:1063`): emits `${appModule}.${handle}.${bare}`, correct only because in `acme.ddd` the api-handle name equals the bounded-context module name (`Sales`). A user who names them differently gets a wrong Phoenix module path. *(Confirmed / failure input in §Deep verification.)*
- **`render-stmt.ts` is per-backend** — statement kinds are edited in N files (unlike expressions, which collapsed to one seam). Idiomatic visitor fan-out, but a real per-feature N-place cost; a few backends' switches have silent `default` arms (e.g. `elixir/render-expr.ts:1200` binary-op fallthrough) that can emit invalid source without a build error.

## Where the real product risk is (from `architecture-weak-spots-2026-07.md`, still current)

The compiler core is the strong part. The existential risks are on the product side and were independently reconfirmed: **(a) UI customization cliff** (display-only tables, one-way ejection, no `component extern` on Angular/HEEx); **(b) schema/data evolution** (no data migrations — a non-heuristic rename silently degrades to drop+add = data loss behind a flag); **(c) security defaults** (authz default-open, shallow OIDC, opt-in optimistic concurrency); **(d) the temporal hole** (no timers/jobs/deadlines in the language or any backend). Widening the target matrix *multiplies* each of these — which is the argument for prioritizing them over target #6.

## Recommended order of attack

Re-ranked by fix-ROI after the deep verification:

1. **HEEx api-call routing fix** (#5) — highest ROI. Silent uncompilable Elixir on a legal `.ddd`; **one-line fix** using the `contextModuleByAggName` map already threaded into `WalkContext`; byte-identical on `acme.ddd`. Do first.
2. **Regex-import `*Id` cross-check** (#4) — a reachable latent `ImportError` (any VO/enum named `…Id`). Cheap targeted fix now (intersect the `*Id` regex hits with declared aggregate-id names); the full used-symbol-set rework across ~17 sites is a larger, lower-urgency cleanup.
3. **Collapse the 4 stamp validators to a table** (#2) — ~160 lines removed, pure validation, safe; preserve Elixir's divergent "request actor" wording. Leave the Dapper/MikroOrm validators (genuinely per-adapter, falsely flagged first pass).
4. **Do NOT** chase a monolithic persistence seam (#1). The write-path decline is a hard wall; `QueryTarget` is a revisit-under-traffic judgment call, not urgent. Spend the effort on promoting one cheap boot gate to per-PR for every backend (the PGlite `behavioral-e2e` pattern generalized) — that catches the migrate/boot bugs the compile gate is structurally blind to.
5. **Sentinel-filter authz** (#3) — correct today; track it. The principled fix (a discriminated `FilterIR` node kind giving compile-time exhaustiveness, converting the future silent-auth-bypass risk into a build break) is a large IR-plus-8-dispatchers refactor, not urgent.

## Deep verification

*Two independent code-level re-audits: one stress-testing the persistence-seam infeasibility claim, one re-checking points 2–5 for reality, justification, fix cost, and the concrete failure case.*

### Persistence seam — write path is a hard wall; query path is a judgment-call decline

Independent re-reading of the emitters (not the mission doc) confirms M-T9.2's *scoping* but corrects its *rationale on the flagship*:

- **Write path — decline is correct and irreducible.** Verified the five save bodies compose on foreign topologies (Drizzle `insert…onConflict` + manual diff-sync `repository-save-builder.ts:30-199` ≈ SQLAlchemy `repository-builder.ts:1087+`; EF change-tracking `dotnet/emit/repository.ts:424-491`; JPA one-liner `java/emit/repository.ts:714-748`; Ecto split verbs `elixir/vanilla/repository-emit.ts:427-437`). Only TS↔Python share the tree. The user is solidly right here.
- **Query path — the "cannot unify" argument is unsound.** The Drizzle operand-split (`repository-find-predicate.ts:185-190`, `renderColumnRef ?? renderColumnRef` probe + separate `renderValue`) vs SQLAlchemy uniform recurse (`find-predicate.ts:177-188`) vs JPQL (`render-jpql.ts:246`) is real *at the byte level* — but it is exactly the leaf divergence a `Target` absorbs. An AST-returning dispatcher does the role-split once and hands `compare(op,col,value)` to leaves that emit `eq(col,val)` (Drizzle) / `(col op val)` (Python) / a JPQL string. The already-shared substrate is confirmed (`isDenyFilter`/`isDeepScopeFilter`/`intrinsicFor`/`intrinsicKey` imported identically by all three); the still-triplicated residue is the ~9-arm walk + the deep-scope composition (TS `:144-156` / Py `:241-254` / Java `:121-131`). So the decline is a defensible cost/benefit choice (3 backends net, substrate already shared), **not** the structural law §0.7 presents.

### Point 2 (stamp validators) — REAL DEBT, partial

`validate{Java,Dotnet,Node,Python,Elixir}StampSupport` (`system-checks.ts:982/1037/1093/1149/1206`) are each ~44 body lines with identical control flow, differing only in a `platformFamily(...) !== "<family>"` guard, a `(platform <x>)` message label, and the `loom.<backend>-stamp-unsupported` code. The four Java/Dotnet/Node/Python collapse to one `[{family,code}]`-driven check (~160 lines removed, safe, diagnostics byte-identical). **Caveat:** Elixir's prose diverges (`:1229` "principal (request actor) to stamp from" + a "system `user {}` block" clause) — a naive collapse would silently reword it, so it needs a per-entry message override. **The Dapper/MikroOrm pair was falsely flagged** — they share only a shape; their gates are genuinely different per-adapter capability matrices (`:1847` vs `:1947`) and should stay separate. First-pass line count was inflated ~180 lines by them.

### Point 3 (auth sentinels) — JUSTIFIED today / MINOR future risk

Backends *do* pattern-match sentinel `ExprIR`s (`DEEP_SCOPE_MEMBER="__loomDeepScope__"`, `DENY_SCOPE_MEMBER="__loomDeny__"` — `tenant-stance.ts:152/160`; ~8 backend sites recognize them). But the auth *decision* is made once in enrichment and backends only *render* the pre-built marker — recognition, not re-resolution — so the "backends never re-resolve" invariant holds (the builder comment at `:84-89` is explicit). **The genuine smell is the lack of compile-time exhaustiveness:** a sentinel is a `method-call` on `this`, so a 6th backend that forgets the arm falls through to the default expr dispatcher and emits either uncompilable `this.__loomDeepScope__(...)` or — worse for `deny` — *nothing that enforces always-false* → **silent authorization bypass / tenant leak**, not a crash. The principled fix is a discriminated `FilterIR` node kind (missing arm → TS compile error), but it touches the IR type + all 8 dispatchers. Correct as written today; worth a tracked "these arms are mandatory and un-enforced" note.

### Point 4 (regex import detection) — REAL DEBT, with a reachable failure

Confirmed the strip-strings-then-`\b`word-boundary-test pattern at ~17 sites, and found a concrete reachable bug: `repository-port-builder.ts:87` harvests **any** capitalized `…Id` identifier (`scan.match(/\b[A-Z][A-Za-z0-9]*Id\b/g)`) and emits `from app.domain.ids import <them>` with no cross-check against declared id types. A value object or enum named `PayrollId` (living in `value_objects.py`) gets imported from `app.domain.ids` → **`ImportError` at module load**, reachable from ordinary `.ddd`. Two more latent cases: PEP-484 string forward-ref annotations get their type stripped before the import test (mis-drop → `NameError`), and triple-quoted docstrings aren't understood by the single-quote strip regex (false-positive → ruff unused-import failure). Cheap targeted fix: intersect the `*Id` hits with `ctx.aggregates.map(a => a.name + "Id")` (kills the ImportError class in a few lines); full fix is a `used: Set<string>` threaded through emission.

### Point 5 (HEEx routing) — REAL DEBT, one-line fix

Confirmed and it's the strongest finding. `heex-walker-core.ts:1060-1088` `renderApiCall` emits `${ctx.appModule}.${handle}.${bare}` where `handle` is the **UI-local api alias** (`UiApiParamIR.name`, an arbitrary label), not the aggregate's context. It only works on `acme.ddd` because there the alias is literally named `Sales` == the context module (`api Sales: SalesApi`). A UI that aliases it differently —

```
ui WebApp { api Shop: SalesApi   // Customer lives in context Sales
  page Customers { Table of: Shop.Customer.all } }
```

— emits `AcmeApp.Shop.list_customers(...)` (module `AcmeApp.Shop` doesn't exist) → **Elixir compile error**, with no validator blocking it (`ui-checks.ts:660` resolves the aggregate by name, ignoring the handle). Every *other* Elixir site already routes via `ctx.contextModuleByAggName` (built in `liveview-emit.ts:114/134`); the fix drops the handle entirely — `const ctxModule = ctx.contextModuleByAggName.get(call.aggregateName) ?? ctx.appModule` — byte-identical on `acme.ddd`, zero golden churn.
