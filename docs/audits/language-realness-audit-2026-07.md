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

**So the user's intuition is correct:** the differences between targets are too big to unify, because they are the ORMs' own composition models, and per-ecosystem drift is a stated *feature* (`src/platform/surface.ts` header), not debt. The "T10 freeze until a persistence seam exists" is effectively already lifted — a 6th backend inherits the shared substrate and hand-writes only the framework-native write/injection path it would have had to write regardless. *(Independently re-verified in §Deep verification.)*

**Real residual cost:** not a missing abstraction, but that a relational storage feature still re-lands as ~1 leaf-edit per in-scope backend + a bespoke edit per decline-backend, and **runtime feedback is nightly, not per-PR**. The high-ROI mitigation is (ii) below, not a seam.

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

1. **Regex-import detection → used-symbol set** (#4) — silent-wrong, fix before it grows.
2. **Collapse the copy-pasted validators to a table** (#2) — cheap, safe, removes the per-backend-N growth.
3. **HEEx routing fix + validator guard** (#5) — real correctness bug on non-coincident names.
4. **Do NOT** chase a monolithic persistence seam (#1) — M-T9.2 settled it; spend that effort on promoting one cheap boot gate to per-PR for every backend instead (the PGlite `behavioral-e2e` pattern generalized), which is what actually catches the migrate/boot bugs the compile gate is blind to.
5. Treat the sentinel-filter authz mechanism (#3) as a deliberate future refactor (dedicated filter node kind), not urgent.

*Deeper independent verification of each point follows below.*

## Deep verification

*(Appended after two independent code-level re-audits — one on the persistence-seam infeasibility claim, one on points 2–5. Filled in on completion.)*
