# Full code & solution review — July 2026

**Scope:** the entire toolchain (`src/` — language, macros, IR, generators, platform, system, CLI/API/MCP/tools), the test/CI surface, and the solution architecture.
**Method:** six parallel deep-review passes (language+macros, validators, IR, backend generators, frontends+walker, system/CLI/tooling, plus a cross-cutting solution/CI pass), each grounding claims by reading code and — for most high-severity findings — reproducing them empirically via `node bin/cli.js parse|generate` on crafted `.ddd` inputs. Baseline: `main` @ `9cec10d`, fast suite green (6,294 passed / 791 files, 768s).
**Status of findings:** every finding below was verified in code; ones marked *(repro)* were additionally reproduced end-to-end against generated output.

---

## Verdict

The architecture is real and the discipline is unusual: the ten-phase one-directional pipeline is test-enforced (with holes noted below), the `ExprTarget`/`WalkerTarget` seams genuinely centralize dispatch, `wireShape` is a real cross-backend contract, enrichment is pure and brand-typed, there is **no SQL injection anywhere**, and every guardrail failure the team has hit historically became a checked-in gate or skill. The fast suite is green and dense (6.3k tests).

The weaknesses are equally systematic, and they cluster into **five root causes** rather than dozens of independent bugs:

1. **Escaping/mangling of `.ddd`-sourced strings and identifiers into generated source is not centralized.** Elixir string literals interpolate `#{…}` unescaped (code injection), Elixir regex sigils splice raw patterns, HEEx text position is unescaped (breaks `mix compile`, executes `<%= %>`), HEEx literal attributes aren't quote-escaped, reserved-word field names emit bare on all five backends, SQL DDL identifiers are a passthrough. One "hostile identifiers and strings" fixture compiled per backend would have caught all of it.
2. **Hand-copied traversals lag the IR.** ≥5 near-identical expression/statement walkers (validate/util/types) each miss different node kinds; `computeSaves`, `deriveNeeds`, and workflow validation walk only flat/primary statement lists. Consequences include silently-lost persistence and validation dead zones.
3. **The "suppress on `unknown`" convention has a false premise.** Bare `NameRef`s have no upstream reporter, so a typo'd identifier produces zero diagnostics and emits verbatim into generated code.
4. **Validation coverage is asymmetric across equally-legal syntactic forms.** Top-level composition members, root-level VOs, `create` params, `hosts:` mounts, and duplicate names all skip checks their sibling forms get.
5. **The per-PR gate tier is thinnest exactly where the recent bug history lives**: runtime wire/persistence semantics on non-Hono backends. 22 of the last 50 commits are `fix:`, overwhelmingly Elixir wire-parity chases that compiled green and failed on round-trip.

Nothing found suggests the "no backend IR" bet is wrong — but the cost has visibly moved from structure (solved) to **runtime semantics** (not yet contracted), and it grows linearly per backend.

---

## Highest-severity findings (cross-layer, ranked)

### Silent wrong behavior in generated systems

> **[2026-07-11 remediation status, code-verified against `main` @ `ad81732e`]** A
> `Status` column is appended below (per the remediation plan's definition-of-done —
> the snapshot text is left intact). **22 of the 24 findings have landed** via #1629
> and successors (see `docs/plans/full-review-remediation.md` §Status and the
> "Remediated in PR #1629" addendum). The **two still-open** findings are **#6**
> (strict decimal/money bounds — a real correctness bug, fix in progress on a
> separate branch, still inclusive-folding on `main`) and **#22** (macro expansion
> under LSP incremental rebuilds — C5, no landing found).

| # | Finding | Where | Status |
|---|---|---|---|
| 1 | **Typo'd bare identifier → zero diagnostics → emitted verbatim.** `NameRef` is not a cross-reference; `typeOf` returns `unknown` and every downstream gate suppresses on `unknown` assuming an upstream reporter that doesn't exist. *(repro: `total := amout` validates clean, emits `this._total = amout;`)* | `src/language/validators/statements.ts:247`, `types.ts:191` | ✅ FIXED (A2, #1629 W1 — bare-`NameRef` resolution reported) |
| 2 | **Workflow mutations of outer bindings inside `for-each`/`if-let` are never persisted.** `computeSaves` never descends into bodies for outer bindings. *(repro: `acct.charge(o.total)` in a loop — charge silently lost)* | `src/ir/lower/lower-members.ts:361-408` | ✅ FIXED (A3, #1629 W1 — shared exhaustive child-walker + `computeSaves`) |
| 3 | **Domain-service `findAll(Criterion)` drops the criterion** (returns all rows — data-exposure-grade) **and calls a nonexistent repo method.** *(repro)* | `src/ir/lower/repo-read.ts:277-292`, `src/ir/enrich/enrichments.ts:442` | ✅ FIXED (B10, #1629 W2) |
| 4 | **Collection-op lambda params typed as a `string` placeholder** → wrong money code inside lambdas (`String(10.00)` concat, raw `>` instead of `.gt`). Falsifies "backends never re-resolve" inside lambdas. *(repro)* | `src/ir/lower/lower-expr.ts:631` | ✅ FIXED (B9, #1629 W2 — collection-op lambda element types) |
| 5 | **Multi-level `extends` silently drops grandparent fields**; migrations emit the column the domain layer never populates → every insert fails. `extends` cycles are also undetected and truncate inheritance. *(repro)* | `src/ir/enrich/enrichments.ts:333-341`; `src/language/validators/inheritance.ts:46-51` | ✅ FIXED (B7 extends-cycle + B11 transitive merge, #1629 W2) |
| 6 | **Strict `>`/`<` invariant bounds folded to inclusive via `n±1`** — wrong for decimal/money: `weight > 0.5` becomes `z.coerce.number().min(1.5)`, rejecting valid input at the API boundary. *(repro)* | `src/ir/validate/invariant-classify.ts:437-458` | 🔴 **OPEN** — still inclusive-folding on `main` (`:445`/`:449`); fix in progress on a separate branch |
| 7 | **Ownership stamp persists the wrong principal attribute on Hono + Java** (`currentUser.role` stamp collapsed to actor id) — declared read filter never matches; per-backend auth divergence. | `src/generator/typescript/emit/audit-stamp.ts:51`, `src/generator/java/emit/entity.ts:290` | ✅ FIXED (B17, #1629 W2 — principal-attribute stamp) |
| 8 | **`isAssignable` accepts any `T?` → any `U?`** (`value.kind === "optional"` disjunct). `int? := string?` validates clean. *(repro)* | `src/language/type-system.ts:273` | ✅ FIXED (B1, #1629 W0 — optional-to-optional assignability) |
| 9 | **Ternaries are completely unchecked** (condition needn't be bool; branches needn't agree). *(repro)* | `src/language/type-system.ts:442-448` | ✅ FIXED (B2, #1629 W2 — ternary typing) |
| 10 | **No duplicate-name checks for aggregates/properties/params/event fields** — duplicates silently replace/retype (a duplicate `aggregate Order` drops the first one's fields entirely). *(repro)* | `src/language/validators/structural.ts` (gap) | ✅ FIXED (B4/B6, #1629 W2 — duplicate-name gates) |

### Generated code that breaks or is exploitable

| # | Finding | Where | Status |
|---|---|---|---|
| 11 | **Elixir string literals emit `#{…}` unescaped** — `mix compile` break; arbitrary Elixir execution from a `.ddd` string literal. *(repro)* | `src/generator/elixir/render-expr.ts:288` (+ heex-walker-core, tests-emit) | ✅ FIXED (A1, #1629 W1 — centralized target-language escaping + hostile-inputs gate) |
| 12 | **Elixir `~r/…/` splices the raw pattern** — a `/` or `#{` in a `matches()` pattern breaks compilation/interpolates. *(repro)* | `src/generator/elixir/render-expr.ts:442`, `vanilla/changeset-validators.ts:36` | ✅ FIXED (A1, #1629 W1 — regex materialization) |
| 13 | **HEEx text position is unescaped** — JSX targets escape via `escapeText`; the parallel HEEx engine never calls it. `Heading { "<%= System.get_env() %>" }` executes at render time; a bare `<` breaks the tokenizer. HEEx literal attribute values also aren't quote-escaped. *(repro, cross-checked against React output)* | `src/generator/elixir/heex-walker-core.ts:1082-1088`, `heex-primitives.ts:42-45` | ✅ FIXED (A1, #1629 W1 — HEEx text position through `escapeText`) |
| 14 | **Reserved-word field/param names emit bare on all five backends** (`class`, `def`, `end`, `synchronized`…) — compile failure everywhere; the `escape<Lang>Ident` helpers exist but are wired only for `let`/`lambda` locals. *(repro)* | `src/util/naming.ts:336-364` + each backend's `render-expr.ts` | ✅ FIXED (A1, #1629 W1 — `escape<Lang>Ident` for all refKinds) |
| 15 | **Unquoted SQL DDL identifiers** — a field named `user`/`order`/`end` emits broken `CREATE TABLE`; the seed path in the same file quotes correctly. | `src/generator/sql-pg.ts:134-140` | ✅ FIXED (A1, #1629 W1 — `qIdent` on DDL idents) |

### Migrations & composition (deploy-time breakage)

| # | Finding | Where | Status |
|---|---|---|---|
| 16 | **Same aggregate name in two contexts derives one migration that creates the same table twice, in the wrong schema** — the canonical DDD scenario (`Sales.Order`/`Billing.Order`), zero diagnostics. *(repro)* | `src/system/migrations-builder.ts:394-427, 501-514` | ✅ FIXED (A8.4 — `loom.duplicate-table` + identity resolution) |
| 17 | **Delta migrations are never schema-qualified** — only `createTable` carries `schema`; every ALTER/DROP on a schema-qualified system targets the wrong relation or fails. *(repro)* | `src/generator/sql-pg.ts:21-45`, `MigrationStep` (no schema field) | ✅ FIXED (A8.1 — `schema?` on every `MigrationStep`) |
| 18 | **`dropTable` ignores FK ordering** (creates are Kahn-sorted, drops are alphabetical) → "cannot drop table" abort. *(repro)* | `src/system/migrations-builder.ts:402-407` | ✅ FIXED (A8.2 — reverse-topological drops) |
| 19 | **Adding a required field derives `ADD COLUMN … NOT NULL` with no default** (fails on any populated table); **renames diff to drop+add** (silent data destruction, no warning/gate). *(repro)* | `migrations-builder.ts:441-451` | ✅ FIXED (A8.3 — `MigrationDestructiveError` / `--allow-destructive` gate) |
| 20 | **No host-port or service-slug uniqueness validation** — two default-port deployables collide at `docker compose up`; case-variant deployable names silently merge into one output dir + duplicate compose keys; user port 8081 collides with hardcoded Keycloak. *(repro)* | `src/system/index.ts:332-392,653`, `src/ir/lower/lower-deployment.ts:183` | ✅ FIXED (B24, #1629 W2 — port/slug uniqueness) |

### Toolchain robustness

| # | Finding | Where | Status |
|---|---|---|---|
| 21 | **Any validator throw kills every diagnostic for the document** (one monolithic Model-level check) — and two crash paths were verified: unknown `platform:` string (`.adapters` on `undefined`) and a `matches()` pattern starting with `"` (`JSON.parse` outside the try, behind a comment that contradicts CLAUDE.md's own STRING-terminal note). *(both repro)* | `src/language/validators/data/platform-rules.ts:298`; `src/language/validators/match.ts:191-192` | ✅ FIXED (B5, #1629 W0 — per-theme validator fault isolation + crash sites) |
| 22 | **Macro expansion is one-shot but LSP incremental rebuilds don't re-fire it** — cross-file macro refs that resolve late never expand, and drained diagnostics vanish on relink; correct for CLI, wrong in a live editor session. | `src/macros/expander.ts:102-127` vs Langium 4.3 `document-builder` | 🔴 **OPEN** — C5, no landing found; `drainMacroDiagnostics` still WeakMap-deletes (`expander.ts:102-106`) |
| 23 | **Top-level (implicit-composition) system members skip the entire per-System check family** — the same deployable errors nested in `system { }`, validates clean top-level. *(repro)* | `src/language/ddd-validator.ts:198-353` | ✅ FIXED (B3, #1629 W2 — top-level composition coverage) |
| 24 | **IR validation walks only the primary create's flat statement list** — `handle`/`on` bodies and nested statements skip every body check; `walkExprsInWorkflowStmt` misses 6 of 13 stmt kinds. | `src/ir/validate/checks/workflow-checks.ts:157,375`, `structural-checks.ts:1024-1051` | ✅ FIXED (A3, #1629 W1 — shared exhaustive IR child-walker) |

---

## Layer-by-layer notes (medium/low, condensed)

### Language & macros
- Let-bound locals typed `unknown` in `envForNode` → every expression-level check on a `let` operand silently disengages (`type-system.ts:961`, `validators/types.ts:113`).
- Same-named entity parts across aggregates resolve by declaration order with no ambiguity diagnostic (`ddd-scope.ts:194`).
- Runtime layering leak `language → platform → generator` via `platform-rules.ts` → `resolve-adapters.ts` → `_adapters` — invisible to the layering gate (direct edges only). Finding 21's crash is a direct consequence.
- Stale hand-listed `PLATFORM_KEYWORDS`/`DESIGN_KEYWORDS` in `print-structural.ts:109-129` (missing python/vue/angular + current packs, still lists retired `phoenix`) — no completeness test, unlike `walker-stdlib.ts`.
- Emit fields / function returns reject literal promotion that `:=`/defaults accept; workflow emit promotes but aggregate emit doesn't (`statements.ts:312`, `lower-stmt.ts:92` vs `lower-workflow.ts:440`).
- `create`/`destroy` params escape the bare-aggregate type-position check; member-call statements (`total.bogus()`) bypass all validation; root-level VO legacy constructor calls slip the rejection.

### IR
- Shared expression walkers: `walkExpr` misses `convert`/`list` and lambda `block` bodies; `exprUsesCurrentUser` additionally misses `match` — five diverging copies (`checks/shared.ts:268`, `loom-ir.ts:2902`, `domain-service-read-ports.ts:74`, `domain-service-tier.ts:214`).
- `wireShape` id row hardcodes `valueType: "guid"`, contradicting `ids int|long|string` — wire-spec.json disagrees with the DB and its own FK entries *(repro)* (`enrichments.ts:1174`).
- `bool = true` create default silently dropped at the wire boundary — omitted field arrives `false` *(repro)* (`wire-projection.ts:161`).
- Bare-name `Repo.run(Name, page: {...})` drops pagination (`repo-read.ts:213`).
- `deriveNeeds` walks only primary top-level statements → capability checks silently skipped for nested `files.put` (`enrichments.ts:254`).
- dotnet exempt from the principal-filter-needs-auth gate → NRE on every read for `user {}` without `auth: required` (`system-checks.ts:1104`).
- "Derive, don't stamp" violations: `WorkflowIR.params/statements/savesAtExit` are stamped facades of `creates[0]` (root cause of the primary-only validation blindness); `canonicalCreate` stamped at two sites.
- Bare `prices.sum` type-admitted but unrenderable (`this._prices.sum.plus(...)`) *(repro)*.

### Backend generators & platform
- Bundle-split boundary defeated transitively: `lower-deployment.ts`/`platform-rules.ts` → `resolve-adapters.ts` → `registry.ts` → **all five generators** in any client bundle; `metadata-boundary.test.ts` checks one hop deep.
- Wildcard CORS default on every backend while a session cookie is also accepted — hardening gap in the runnable stack.
- Phoenix `SECRET_KEY_BASE` is one hardcoded public constant across all generated apps (`src/platform/elixir.ts:78`) — forgeable session cookies unless manually rotated.
- `fs-discovery.ts` never enforces the `core` semver gate its manifest promises; out-of-tree backends and malformed `loom` blocks are silently dropped.
- Frontend host dispatch contradicts `hostableFrameworks`: a validator-legal `platform: react` host of a `framework: vue` ui silently emits a React project.
- Stamp fields are required client-writable inputs in every create DTO (mass-assignment surface; currently overwritten at persist).
- TS `asRegexLiteral` edge cases: `matches("")` renders `//` (a comment); trailing-backslash pattern breaks the literal.
- `emitsCommandRoute`/`collectLeaves` copy-pasted across backends — IR-analysis predicates that belong in `src/ir/util/`.

### Frontends & walker
- Vue walker seams hard-throw on valid input when a rendered expression contains both quote kinds (`vue-target.ts:167,207,290`) — aborts generation for the whole system; `renderConditionalChild` has *no* guard and silently emits broken `v-if`.
- `heex-parity.test.ts` measures registry **presence**, not behavior — it stays green while both renderers exist and disagree on escaping (which is exactly what shipped). Half of `heexTarget` is unreachable contract-completeness stubs that the conformance test validates while the live path diverges.
- Angular compound state read on a nested target omits the signal call (`walker-core.ts:1445`).
- `WalkResult` carries six Angular-specific `unknown[]` side-channels on the shared shape — a target-owned opaque sink would keep it framework-neutral.

### System, CLI, tooling
- Corrupted `.loom` snapshot silently treated as first run → re-baselined "Initial" migration against an existing DB (`snapshot.ts:26`).
- `--dry-run` creates the output dir and overcounts ("would write 35" where a real run writes 0) (`cli/main.ts:366,407`).
- `ddd verify --min 90%` → `NaN` comparison → gate silently passes (`cli/main.ts:682`).
- `serviceSlug` re-implements a weaker `snake()` outside `naming.ts`, untested.
- No containment guard on generated paths (`path.join(outDir, relPath)`) — not currently exploitable (grammar IDs), cheap defense-in-depth before out-of-tree packs become real.
- The MCP/tools/api stack itself is exemplary (pure, transport-neutral, throws → tool errors, zero tool logic in the server).

### Solution / CI / health
- **Per-PR runtime-behavior coverage:** behavioral round-trips run per-PR only for Hono over a 2-system corpus; everything else is nightly or label-gated. The commit log is the proof (the serial Elixir wire-parity fix series #1620–#1628, all compile-green/round-trip-red).
- **Elixir has the narrowest per-PR compile gate of any backend** (`elixir-vanilla-build.yml` path filter excludes `src/ir/**`, `_expr/**`, even `elixir/render-expr.ts`; `corpus-build.yml` has no elixir leg) — the weakest gate on the most volatile target.
- **Layering tests have structural blind spots:** `IMPORT_RE` misses side-effect/dynamic imports; `src/macros/` and `src/platform/**` scanned by no layering test; generator files checked only against `system` (an existing `generator → language` value import passes silently: `walker-core.ts:66` → `walker-stdlib.js`); the sibling-edge fence is 13 pinned exceptions deep (backend→react fullstack embeds — composition happening below `system/`).
- **`npm audit` high-severity is the toolchain's own MCP wrapper** (`ddd-mcp → @modelcontextprotocol/sdk → @hono/node-server → hono@4.12.23`, path-traversal GHSA-wwfh-h76j-fc44 et al.). Generated apps are *not* affected (hono pinned ^4.12.26 in `pins.ts`). `npm audit fix`-able.
- **CLAUDE.md drift** in a repo where CLAUDE.md is load-bearing for parallel agents: duplicate `designs/` and `api/, vite/, docker/` table rows; `src/platform/hono/v5/` + `packages/backend-hono-v5` exist but are undocumented; "three JSX targets" vs the workflows section's (correct) four.
- Fixture strategy (1.7 MB / 303 committed files) workable but rubber-stamp-prone on 100-file regen diffs; `npm test` exclude list triplicated by hand in package.json; direct `chevrotain` pin duplicates Langium's and can silently diverge.

---

## What's genuinely good

- Layering enforced by tests with empty exception lists and vacuous-pass guards; branded `EnrichedLoomModel` makes "forgot a phase" a compile error.
- `ExprTarget` / `WalkerTarget` seams at the right altitude: 17-arm dispatch written once; adding a backend = writing leaf tables. `wireShape` as the single ordered DTO contract is the architectural payoff, realized.
- **No SQL injection anywhere** — all five backends parameterize; global auth middleware, EF global query filters, real JWT verification (JWKS, issuer/audience/expiry, `alg:none` rejected), sanitized 500s, `sensitive(pii)` redaction.
- Exhaustiveness discipline: printer completeness tests, walker-stdlib completeness, print round-trip gates, per-`ExprIR.kind` arm tests per backend, diagnostic-code registry test.
- Every past guardrail failure became a checked-in gate or skill (heex-parity freeze, pre-push merge-tree hook, `generated-stack-verifier`); `experience_gathered.md` and PR-numbered test rationale make the codebase honestly auditable.
- CI economics are engineered: 4-way sharding with a single roll-up status, path-filtered matrices, label-gated heavy tiers.

---

## Recommendations (ranked by leverage)

1. **Close the escaping bug class at the seams, not per-site.** One escaper per target language for (a) string literals (Elixir: escape `#{` or use `~S`), (b) regex materialization, (c) HEEx text position (funnel through the existing-but-dead `escapeText`), (d) identifiers derived from `.ddd` names (route through the existing `escape<Lang>Ident` for *all* refKinds, not just locals), (e) SQL DDL idents (use the `qIdent` already in the file). Add one cross-backend "hostile inputs" fixture (fields named `class`/`end`, a `matches` pattern with `/"#{`, string literals with `"` `<` `#{`) that generates and compiles on every backend.
2. **Fix the `unknown`-suppression premise:** add a bare-`NameRef` resolution check (or make it a Langium cross-reference) so a typo is a diagnostic, not emitted code. Then the sibling gates' suppression convention becomes sound.
3. **One shared, exhaustively-`never`-checked IR child-walker** replacing the ≥5 hand copies, plus a property test ("every ExprIR/StmtIR kind's children are visited"). This retires findings 2, 24, the `walkExpr`/`currentUser` gaps, and `deriveNeeds` in one stroke, and prevents the next one.
4. **Wrap each themed validator in its own try/catch** (or per-check dispatch) so one throw costs one check, not the document; fix the two known crash paths.
5. **Migrations hardening:** schema on every `MigrationStep`; reverse-topological drops; qualify or reject duplicate table names across contexts (plus a duplicate-aggregate-name validator); guard NOT-NULL-add and rename-as-drop/add behind an explicit decision (destructive-change gate).
6. **Uniqueness validators:** host ports, service slugs, duplicate declaration names (aggregate/property/param/event field), cross-aggregate part-name ambiguity.
7. **Give Elixir per-PR parity teeth:** widen `elixir-vanilla-build.yml` path filters to `src/ir/**` + `src/generator/_expr/**` + all of `src/generator/elixir/`, add an elixir corpus-build leg, and start a "runtime semantics contract" (casing/casting/assoc-persistence/error-envelope) analogous to `wire-spec.json` — the recent fix-avalanche is what one backend drifting looks like.
8. **Patch the layering gates' blind spots** (side-effect/dynamic imports, scan `platform/` + `macros/`, check generators against `language` too) and fix the two transitive leaks they'd then catch.
9. Housekeeping: `npm audit fix` for the MCP hono CVE; de-duplicate the CLAUDE.md table rows and document hono v5; per-doc drift is load-bearing here.

---

## Remediated in PR #1629

The findings above are being drained by the plan in
[`docs/plans/full-review-remediation.md`](../plans/full-review-remediation.md).
As of this note, the following waves have landed (this section is an addendum —
the findings above are the original snapshot and are deliberately left intact):

- **Wave 0** (immediate): D1 (MCP hono CVE), A6.1 (Elixir gate paths), B5 (validator crash sites), B1 (optional-to-optional assignability), B25 (`--dry-run` parity), B26 (`verify --min` guard), A8.5 (loud snapshot corruption).
- **Wave 1 seams**: A1 (centralized target-language escaping + hostile-inputs gate), A2 (report unresolved bare identifiers → sound `unknown`-suppression), A3 (shared exhaustive IR child-walker + `computeSaves` fix), A4 (per-theme validator fault isolation + fuzz gate).
- **Wave 2 fixes** (riding the seams): B2–B4, B6–B8 (ternary/let-binding typing, duplicate-name gates, top-level composition coverage, extends-cycle + part-ambiguity), B9–B16 (collection-op lambda element types, domain-service criterion, transitive inheritance merge, honest wire id types, `bool = true` default, bare-name run pagination, dotnet principal-filter gate), B17–B20 (principal-attribute stamp, stamp fields out of create DTOs, host-framework dispatch, descriptive unknown-platform errors), B21–B22 (Vue quote-safe seams, Angular nested compound state reads), B24 (port/slug uniqueness).
- **C/D sweep** (this PR): C8 (env-driven CORS origin on the three backends that emitted wildcard `*`; Java/Elixir already same-origin-safe), C9 (per-project Phoenix `SECRET_KEY_BASE`), C10 (fs-discovery `loom.core` semver gate + unknown-family / malformed-manifest warnings), C13 (CLI output-path containment), C14 (`WalkResult` Angular side-channels → one opaque `sink`), D2–D9 (CLAUDE.md drift, dead-code sweep, pluralisation dedup, `package.json` exclude-list + chevrotain, `emitsCommandRoute` dedup, reserved-hook removal, union-name canonicalisation).

Still open at the time of this note: A5 (WorkflowIR facade retirement), A6.2/A6.3 (behavioral tier beyond Hono, runtime-semantics contract), A7.2/A7.4 (adapter-metadata split, fullstack-embed seam), and the remaining B/C mediums not listed above.

> **[2026-07-11 update, code-verified against `main` @ `ad81732e`]** The
> "A8.1–A8.4 (migrations-IR hardening) still open" claim above was written mid-#1629
> and is stale — **all four landed** (the audit's migration repros #16–19): A8.1
> `schema?` on every `MigrationStep`, A8.2 reverse-topological drops, A8.3
> `MigrationDestructiveError`/`--allow-destructive` gate, A8.4 `loom.duplicate-table`
> (see `docs/plans/full-review-remediation.md` §Status, "A8.1–A8.4 — DONE"). Of the
> 24 findings, only **#6** (strict decimal/money bounds — fix in progress on a
> separate branch, still inclusive-folding on `main`) and **#22** (macro LSP
> incremental rebuild — C5, no landing found) remain open.

---

*Generated as a snapshot-in-time audit; per repo convention (`docs/audits/`), treat as the state of `main` @ `9cec10d`, 2026-07-02 — parity claims rot fast.*
