# Remediation plan — full code & solution review (July 2026)

**Input:** [`docs/audits/full-code-review-2026-07.md`](../../audits/full-code-review-2026-07.md) (main @ `9cec10d`).
**Shape:** architectural alignments first (Workstream A) — each one retires a *class* of bugs and gives the later fixes a seam to land on — then high-severity correctness fixes (B), mediums (C), and housekeeping (D). Every audit finding maps to exactly one slice; slices are PR-sized and independently mergeable unless a dependency is called out.
**Effort key:** S = ≤½ day, M = 1–2 days, L = 3–5 days.

---

## Principles

1. **Fix the class, not the site.** Where the audit found N instances of one root cause (escaping, hand-copied walkers, suppression-on-unknown), the slice builds the seam + gate first, then mechanically migrates the sites. A point-fix without the gate regrows the bug.
2. **Gate before fix where the gate is cheap.** Several slices start by adding the failing test/fixture (hostile-inputs corpus, walker property test, dry-run parity test) so the fix is verified and the regression is impossible.
3. **Ride the existing discipline.** Each new invariant becomes a completeness/property test in the style the repo already uses (`print-completeness`, `walker-stdlib-completeness`, layering tests) — that pattern demonstrably sticks here.
4. **Diagnostics over crashes, decisions over silence.** Validator throws become per-check diagnostics; destructive migrations become explicit user decisions; silent drops become `loom.*` codes.

---

## Workstream A — Architectural alignments

### A1. Centralized target-language escaping (the injection/compile-break class)
**Retires audit findings 11, 12, 13, 14, 15 + TS regex edges, Vue quote guards, HEEx literal attrs.**

Today, escaping of `.ddd`-sourced strings/identifiers into generated source is per-site and inconsistent — hence Elixir `#{}` interpolation (code execution), raw regex sigils, unescaped HEEx text, bare reserved words on all five backends, and passthrough SQL DDL idents.

- **A1.1 (M) — Define the escaping surface on the existing seams.** Add four required leaf methods per target where they don't exist yet, and *route all emission through them*:
  - `stringLit(value)` on `ExprTarget` — Elixir escapes `#{` (or emits `~S`), others keep `JSON.stringify`. Kill every direct `JSON.stringify(...)` re-quote in `render-expr.ts` / emitters (`src/generator/elixir/render-expr.ts:288`, `heex-walker-core.ts:443`, `vanilla/tests-emit.ts`).
  - `regexLit(pattern)` on `ExprTarget` — Elixir escapes `/` + `#{` in `~r/…/` (or uses a non-`/` delimiter); TS handles `""` and trailing-`\` (`typescript/render-expr.ts:494`); C#/Java/Python keep non-interpolating string wrapping. Migrate `vanilla/changeset-validators.ts:36`, `vanilla/document-emit.ts:150`.
  - `ident(name, position)` — one funnel over the existing `escape<Lang>Ident` helpers (`src/util/naming.ts:336-364`), called for **every** identifier derived from a `.ddd` name (fields, params, this-props), not just `refKind: let|lambda`. Positions: local, member, param, field-decl.
  - SQL: make `ident()` in `src/generator/sql-pg.ts:134` delegate to the `qIdent` already in the file (quote-always is safe for Postgres DDL since the emitters own both sides).
- **A1.2 (S) — HEEx text funnel.** In the parallel HEEx engine, route every text-position emit (`renderInTemplate`/`renderChild`/`renderLiteral`, `heex-walker-core.ts:1082-1088`, and the per-primitive emitters in `heex-primitives.ts`) through one escaper — resurrect the currently-dead `heexTarget.escapeText`. Quote-escape literal attribute values in `attrValue` (`heex-primitives.ts:42-45`), mirroring the already-safe dynamic branch.
- **A1.3 (M) — The hostile-inputs conformance fixture (the gate).** One `.ddd` fixture: fields/params named `class`, `def`, `end`, `order`, `user`; a `matches("^a/b\"#{x}$")` pattern; string literals containing `"` `<` `&` `#{` `<%= %>`; a heading/text with the same. A test generates it for **all five backends + all four frontends** and runs each target's cheapest syntax check (tsc single-file, `mix compile` on the one module in the elixir docker image where available — otherwise pin exact emitted bytes). This lands *first* in the slice as a red test.
- **Order:** A1.3 (red) → A1.1 → A1.2 → A1.3 green. Byte-identical output expected everywhere the input is non-hostile — gate with the fixture-capture diff as in prior seam extractions (PR #843 pattern).

### A2. Sound name resolution — fix the `unknown`-suppression premise
**Retires finding 1 (typo'd bare identifier emits verbatim) and makes every downstream suppress-on-`unknown` gate sound.**

- **A2.1 (L) — Report unresolved bare heads.** Preferred: a dedicated `checkUnknownNameRefs` validator that walks every expression position and errors when a bare `NameRef` head resolves to nothing in `envForNode` scope (params, lets, this-props, enum values, repos, stdlib). This keeps `NameRef` out of the Langium cross-ref machinery (which the grammar deliberately avoids) while restoring the invariant the sibling checks assume: *`unknown` implies already-reported*. Alternative (bigger, better long-term): promote `NameRef` to a scoped cross-reference — evaluate cost against `ddd-scope.ts` complexity before committing; do not block the checker on it.
- **A2.2 (S) — Un-suppress `checkEmit`** (`statements.ts:312`) *in the same PR* — it currently lacks the `unknown` guard and is accidentally the only typo catch in emit args; once A2.1 reports at the source, give it the same suppression as its siblings.
- **Gate:** negative tests for typo'd head in `:=` RHS, let initializer, emit arg, invariant, lambda body. IR-level assert: lowering never receives an unresolvable `NameRef` (throw with context instead of emitting).

### A3. One shared, exhaustive IR walker
**Retires findings 2 (lost saves), 24 (primary-only validation), the 5 diverging `walkExpr`/`currentUser` copies, `deriveNeeds` shallowness, and prevents the next lagging copy.**

- **A3.1 (M) — `src/ir/util/walk.ts`**: `walkExprChildren(e, visit)`, `walkStmtChildren(s, visit)`, `walkWorkflowStmtChildren(s, visit)` with exhaustive `never`-checked switches over `ExprIR`/`StmtIR`/`WorkflowStmtIR` kinds (including `convert.value`, `list.elements`, lambda `block` bodies, `match` arms, `for-each`/`if-let`/`assign`/`repo-run`/`resource-call`/`domain-service-call`). Property test: for every kind, construct a node with sentinel children and assert each is visited — a new IR kind fails this until wired.
- **A3.2 (M) — Migrate the copies**: `checks/shared.ts:268`, `loom-ir.ts:2902` (`exprUsesCurrentUser`), `domain-service-read-ports.ts:74`, `domain-service-tier.ts:214`, `structural-checks.ts:1024` (`walkExprsInWorkflowStmt`), `enrichments.ts:254` (`deriveNeeds` → recursive). Each migration is behavior-*changing* where the copy had gaps — add the specific regression test per closed gap (currentUser-in-match, repo-read-in-match-arm, nested `files.put` capability check).
- **A3.3 (M) — `computeSaves` on the shared walker** (`lower-members.ts:361-408`): collect op-calls against *outer* bindings inside `for-each`/`if-let` bodies into `savesAtExit` (or per-iteration where the binding is loop-local). End-to-end test: the audit's repro (`acct.charge(o.total)` in a loop) must emit `save(acct)`.
- **Depends on:** nothing. **Blocks:** B-slices touching workflow validation (A5).

### A4. Validator fault isolation
**Retires finding 21 (one throw kills all diagnostics) as a class; the two known crash sites are B-fixes riding it.**

- **A4.1 (M) — Per-theme dispatch with isolation.** `DddValidator.check` is one Model-level function; split the dispatcher so each themed check family runs inside a guard that converts a throw into a single `error` diagnostic naming the check (plus `console.error` of the stack in non-browser builds) and *continues* with the remaining families. Cheap version: wrap each `check*` call site in `ddd-validator.ts:198-353`; better version: register per-theme Langium checks so Langium isolates them natively — pick after measuring how much of the walk is shared.
- **A4.2 (S) — Fuzz gate:** a test that runs the full validator over every `examples/*.ddd` + `web/src/examples/*.ddd` + a corpus of deliberately-broken inputs (unknown platform string, quote-leading regex, bogus design pack) asserting *no unhandled throw* and *diagnostics still produced for unrelated known errors in the same file*.

### A5. Derive-don't-stamp: retire the `WorkflowIR` primary-create facade
**Root cause of finding 24's blindness; aligns with the repo's own §15 rule.**

- **A5.1 (L) —** `WorkflowIR.params/statements/savesAtExit` duplicate `creates[0]`; `workflowUsesCurrentUser`, `workflowIsGuarded`, `computeWorkflowReturnType`, and the workflow checks read only the facade. Replace facade reads with all-creates + `handle`/`on` walks (via A3.1), then delete the stamped fields (or keep them as deprecated getters for one release). De-duplicate the double stamping of `canonicalCreate`/`canonicalDestroy` (`lower.ts:1201`, `enrichments.ts:835`) into one derived helper.
- **A5.2 (M) —** Extend the workflow body checks (`workflow-checks.ts:157,375`) to every body; fix the `if let` factory-let false positive (`workflow-checks.ts:724-744` — register branch factory-lets in `bindingAgg`).
- **Depends on:** A3. **Gate:** negative tests for unknown emit/repo/method inside `handle`/`on` and non-primary creates; positive test for the `if let` factory-let shape.

### A6. Per-PR runtime-parity economics (Elixir first)
**Addresses the strategic finding: compile-green/round-trip-red regressions land serially on main.**

- **A6.1 (S) — Widen Elixir gate path filters:** `elixir-vanilla-build.yml` must trigger on `src/ir/**`, `src/generator/_expr/**`, `src/generator/elixir/**` (all of it), `src/platform/elixir.ts`. Add an elixir leg to `corpus-build.yml`.
- **A6.2 (M) — Behavioral tier beyond Hono:** **scoped 2026-07-05 →
  [`a6.2-behavioral-tier-second-backend.md`](a6.2-behavioral-tier-second-backend.md).**
  The "SQLite/PGlite-equivalent" guess was refuted (generated DDL is
  Postgres-specific — jsonb/`pgEnum`); no non-Hono backend has an in-process
  Postgres. Recommended path: HTTP-dispatch the *existing* emitted api-tier e2e
  (the runner's `dispatch` seam is already abstracted) against a booted Python
  FastAPI backend on a `services: postgres` sidecar (the obs-python boot recipe
  is liftable). The `conformance-parity`-required fallback is noted but gates
  only the *structural* contract, not the runtime-value RS-rules. Open call:
  whether a service container counts as "per-PR". Not yet built.
- **A6.3 (L) — Runtime-semantics contract doc + artifact: v1 LANDED (2026-07-05).**
  `docs/conformance-semantics.md` + the `test/conformance/semantics-rules.ts`
  registry + well-formedness gate ship; the three source-assertable rules are
  gated per-PR (RS-2 `enum-casing-parity`, RS-3 `wire-no-leak-parity`, RS-5 the
  pre-existing `union-find-absence-parity`). Remaining: the behavioral RS-rules
  (ride A6.2) and the `.loom/semantics-spec.json` diff artifact (v2).
- **Sequencing:** A6.1 immediately (one-file change); A6.2/A6.3 after B-wave lands so the contract codifies the *fixed* behavior.

### A7. Layering gates: close the blind spots, then fix what they catch
**Retires the transitive `language→platform→generator` leak, the bundle-split defeat, and the unscanned dirs.**

- **A7.1 (S) — Harden the gates:** `pipeline-layering.test.ts` — match side-effect imports and `import(`; scan `src/macros/` (phase ② may import `language`, nothing downstream) and `src/platform/**`; check generator files against `language` (type-only exempt) in addition to `system`. Expect new failures — pin them with rationale in the same PR, then drain:
- **A7.2 (M) — Injectable adapter metadata:** `resolve-adapters.ts` reads from `registry.ts` (pulling all five generators into any client bundle and completing a runtime cycle). Split adapter/stub metadata into a leaf module (the `setBackendVersionSource` precedent) consumed by `platform-rules.ts` and `lower-deployment.ts`; `registry.ts` keeps the composition role.
- **A7.3 (S) — Relocate `WALKER_LAYOUT_PRIMITIVES`:** `walker-core.ts:66` value-imports from `language/walker-stdlib.js`; move the shared name set to `src/util/` per the stated convention, keep the language mirror + completeness test.
- **A7.4 (M, deferrable) — Fullstack-embed seam:** the 13 pinned backend→react edges are composition below `system/`. Design a host-embed hook on `PlatformSurface` so `system/` does the pairing; do this as its own plan doc — don't rush it, the pins are documented and stable.

### A8. Migrations IR hardening
**Retires findings 16–19 as a class: schema-awareness, ordering, and destructive-change policy.**

- **A8.1 (M) — `schema` on every `MigrationStep`** (`migrations-ir.ts`), rendered by `sql-pg.ts` for ALTER/DROP/INDEX exactly as `createTable` does. Snapshot format bump: tables keyed by `schema.table`, with a one-time migration of existing `.loom` snapshots (read old key format, write new).
- **A8.2 (S) — FK-aware drops:** reverse the Kahn order for `dropTable`s (`migrations-builder.ts:402-407`); emit column-level FK drops before the table drops they unblock.
- **A8.3 (M) — Destructive-change gate:** classify steps (additive / destructive / blocking). `dropColumn`-after-`addColumn` of a same-type field = probable rename → emit `renameColumn` when unambiguous, else a `loom.migration-destructive` **error** requiring an explicit marker (`@allow-drop` annotation or `--allow-destructive` flag — pick one, document in `docs/migrations.md`). NOT-NULL-add on an existing table → require a default or emit the three-step add-nullable/backfill-todo/set-not-null pattern with a diagnostic.
- **A8.4 (S) — Duplicate-table guard:** error (IR validate, `structural-checks.ts`) when two aggregates in one system resolve to the same `schema.table`; fix `shapeOf`/`schemaOf` name-only context resolution (`migrations-builder.ts:501`) to resolve by identity, which also fixes the wrong-schema stamping.
- **A8.5 (S) — Loud snapshot corruption:** `fsSnapshotStore.read` (`snapshot.ts:26`) — a parse failure is an error naming the file, never a silent re-baseline.
- **Gate for all of A8:** extend `test/ir/migrations-builder.test.ts` with the audit's four repros (dup name across contexts, schema-qualified delta, FK-ordered drop, NOT-NULL add) + one docker apply-test in the `generated-stack-verifier` style.

---

## Workstream B — High-severity fixes (ride the A-seams)

Grouped by layer; each is one PR unless noted. Audit finding numbers in brackets.

### Language / type system
- **B1 (S) [8]** `isAssignable`: optional-value arm becomes `isAssignable(value.inner, target.inner)` (`type-system.ts:273`). Tests: `int? := string?` errors; `int? := int?`, `never → T?`, `T → T?` still pass. Expect fallout in examples — fix them, they're real bugs.
- **B2 (M) [9]** Ternary checking: condition must be `bool`; branch types must join (share an `isAssignable` direction or common supertype); `typeOf(TernaryExpr)` returns the join, not blindly the then-branch (`type-system.ts:442`).
- **B3 (S)** Let-bound locals: `collectLetBindings` (`type-system.ts:961`) uses the precise type `checkStatement` already computes — unify the two env builders. Test: `let s = "hello"; requires s > 5` errors.
- **B4 (M) [10]** Duplicate-name validator family: aggregate/VO/event names per context, property/derived names per aggregate, event fields, operation params. One themed validator (`validators/duplicates.ts`), stable codes, negative test each.
- **B5 (S) [21]** Fix the two crash sites (rides A4 but doesn't wait for it): `platform-rules.ts:298` — guard `adaptersFor` for unknown families (return quiet, per its own docstring); `match.ts:191` — delete the wrong-comment `JSON.parse` branch entirely (STRING is already delimiter-stripped; the branch corrupts legit quote-leading patterns).
- **B6 (M) [23]** Top-level composition members: route top-level `Deployable`/`Ui`/`ThemeBlock`/`AuthBlock`/`Api`/`Storage`/`Resource`/`Layout` through the same per-System check family (`ddd-validator.ts:198-353`). Test: the audit's react-deployable-missing-ui repro errors in both forms.
- **B7 (S) [5b]** `extends` cycle detection in `inheritance.ts` (visited-set walk, error on cycle); fix the false comment at `type-system.ts:768`.
- **B8 (S)** Cross-aggregate part-name ambiguity: duplicate bare `EntityPart` names exported to global scope get a diagnostic at the *reference* (ambiguous) or *declaration* (duplicate exported name) — pick reference-site for precision (`ddd-scope.ts:194`).

### IR
- **B9 (M) [4]** Thread the receiver's element type into collection-op lambda envs (`lower-expr.ts:631`) — replaces the `string` placeholder. Tests: money arithmetic + comparison inside `any`/`filter`/`map` lambdas render `.plus`/`.gt` on TS, correct forms per backend (per-`ExprIR.kind` arm tests).
- **B10 (M) [3]** Domain-service reads: carry the criterion through `matchRepoRead` (`repo-read.ts:277`) and extend `synthesizeFindAllRetrievals` (`enrichments.ts:442`) to domain-service bodies so the emitted repo method exists. Tests for `readKind: find/findAll/run` in domain services (currently zero coverage).
- **B11 (M) [5]** Inheritance merge = transitive closure over the chain (`enrichments.ts:333`), `tableOwnerName` resolves to the root table owner (`ir/util/inheritance.ts:93`). End-to-end test: 3-level chain generates all fields and a consistent TPH table. (Pairs with B7.)
- **B12 (M) [6]** Exclusive bounds: `invariant-classify.ts` keeps strictness (`minExclusive`/`maxExclusive`); consumers render natively — zod `.gt()/.lt()`, FluentValidation `GreaterThan`, pydantic `gt=`, Bean Validation `@DecimalMin(inclusive=false)`, Ecto `greater_than:`. Only fold `n±1` for **int** where a native form is missing.
- **B13 (S)** `wireShape` id row carries the aggregate's actual id valueType (`enrichments.ts:1174,1214,1424`); wire-spec + Java DTO follow. Test: `ids int` produces `"type":"integer"` in wire-spec matching the migration column.
- **B14 (S)** `bool = true` default: `wire-projection.ts:161` emits the declared default instead of deferring to the hardcoded `.default(false)` bool rule (`routes-builder.ts:1425` and per-backend equivalents). Test with `= true` (the `= false` test masks it).
- **B15 (S)** Bare-name `Repo.run(Name, page:)` reads the page arg like its sibling branches (`repo-read.ts:213`).
- **B16 (S)** Remove dotnet's exemption from the principal-filter-needs-auth gate (`system-checks.ts:1104`) — or implement the anonymous-safe filter; the error is the cheap correct option today.

### Generators
- **B17 (M) [7]** Ownership stamp on Hono + Java: persist the declared RHS (`currentUser.role` etc.), not the collapsed actor id (`audit-stamp.ts:51`; Java `@CreatedBy`/`AuditorAware` only fits the id case — role stamps need a lifecycle hook). Cross-backend conformance test: stamp+filter round-trip (create then read back as the creator) must succeed on all five — this is exactly an A6.3 semantics rule.
- **B18 (S)** Stamp fields out of inbound create DTOs on all backends (mass-assignment hygiene; they're server-populated). Wire-spec change — flag in PR body.
- **B19 (S)** Frontend host dispatch honors `framework:`: add the missing dispatch arms (Vue has none) or shrink `hostableFrameworks` to what each surface actually dispatches — pick one source of truth and add a conformance test tying the capability list to dispatch (`platform/react.ts:27`, `svelte.ts:39`, `angular.ts:42`, `vue.ts:39`).
- **B20 (S)** Typo'd frontend ref: `registry.ts:226` / `metadata.ts:238` throw the descriptive error the backend path already has, instead of returning `undefined` as non-optional.

### Frontends
- **B21 (M)** Vue quote-collision: replace the three hard throws + one silent break (`vue-target.ts:167,207,290,306`) with correct escaping (Vue attribute values support `&quot;`/`&#39;` entities) — same input renders on all four frontends. Keep a diagnostic only if some expression is genuinely unrepresentable.
- **B22 (S)** Angular nested compound state read includes the signal call (`walker-core.ts:1445`: first segment through `renderStateRead`, then the tail).
- **B23 (M)** heex-parity becomes behavioral: keep the presence check, add a cross-target output-property test — for each shared primitive, text-position specials (`<`, `&`, `#{`, `{{`) are escaped on every target (rides A1.3's fixture). Delete or un-dead the `heexTarget` stubs so the contract test exercises live paths only.

### System / CLI
- **B24 (S) [20]** Uniqueness validators: host ports (including the Keycloak 8081 constant) and service slugs (case-variant collision) in `system-checks.ts`; `serviceSlug` delegates to `naming.ts` `snake` (behavior change for `MyAPIServer` — note in PR).
- **B25 (S)** `--dry-run` touches nothing (move `mkdirSync` below the branch) and reports write/skip parity with the real run (`cli/main.ts:366,407`). Parity test: dry-run over an up-to-date tree reports 0 writes.
- **B26 (S)** `verify --min` rejects non-numeric/out-of-range values (`cli/main.ts:682`).

---

## Workstream C — Medium fixes

- **C1 (S)** Emit/function literal promotion parity: give `checkEmit`/`checkFunction` the `canPromoteLiteralTo` escape their siblings have; unify aggregate-emit lowering on `lowerExprInContext` (`lower-stmt.ts:92` vs `lower-workflow.ts:440`).
- **C2 (S)** `create`/`destroy` params join the bare-aggregate type-position check owner list (`structural.ts:130`).
- **C3 (S)** Member-call statements (`total.bogus()`) validated: resolve the member chain, error on unknown member / non-callable (`statements.ts:338`).
- **C4 (S)** Root-level VO/payload legacy constructor-call rejection (`builder-call.ts:64` scans context members only; align with `checkBuilderCallType`'s 2b/2c resolution).
- **C5 (M)** Macro expansion under LSP incremental rebuilds (`expander.ts:102-127`): track expansion state per document version; re-run expansion when a relink invalidates a previously-failed `bindArgs` (the cross-file scaffold case), and don't drain diagnostics on WeakMap-delete before a re-validation without re-parse. Add the currently-missing expander idempotency/incremental test. (Scoped to LSP; CLI unaffected.)
- **C6 (S)** Printer keyword mirrors get completeness tests against the grammar's `Platform`/`DesignPack` rules (`print-structural.ts:109`) — the `walker-stdlib` pattern; fix the stale sets in the same PR.
- **C7 (S)** `hosts:`-mounted uis get the same api-binding validation as `ui:` (`deployable.ts:601`).
- **C8 (S)** Wildcard CORS default: emit a configurable origin (env-var with a dev default of the known frontend origins from the compose topology — the generator *knows* them) on all backends.
- **C9 (S)** Phoenix `SECRET_KEY_BASE`: generate per-project randomness at `generate` time into `.env` (compose `env_file`), never a shared constant (`platform/elixir.ts:78`).
- **C10 (M)** `fs-discovery.ts`: enforce the `core` semver gate it promises; unknown-family manifests and malformed `loom` blocks produce a warning diagnostic, not silence.
- **C11 (S)** Bare collection accessors (`prices.sum` without lambda): either render them (TS: reduce; per-backend arms) or reject in the type system — rejecting matches the documented form `xs.sum(x => …)`; do that (`lower-expr.ts:1550`, `stepInto:541`).
- **C12 (S)** `composition.ts` counts systems across the import graph, not `LangiumDocuments.all` (multi-project LSP workspace false positive).
- **C13 (S)** Output-path containment assert in the CLI write loop (`cli/main.ts:419`) — reject `..`/absolute keys; cheap defense before out-of-tree packs are real.
- **C14 (S)** `WalkResult` Angular side-channels → one target-owned opaque `sink` (`walker-core.ts:170-199`, `target.ts:452`).
- **C15 (S)** Stale validator messages (python missing from serves-list, elixir/python missing from deployable hint, wrong backend sets at `system-checks.ts:1423,1995`) — one sweep, pin with a message-accuracy test where lists are derivable from the registry.

---

## Workstream D — Housekeeping / low

- **D1 (S)** `npm audit fix` — the MCP wrapper's transitive `hono@4.12.23` (generated apps already pin ^4.12.26).
- **D2 (S)** CLAUDE.md: de-duplicate the `designs/` + `api/, vite/, docker/` table rows; document `src/platform/hono/v5/` + `packages/backend-hono-v5`; fix "three JSX targets" → four. (Run the `status-refresh` skill.)
- **D3 (S)** Dead code sweep (all verified zero-importer): `auditedTargets`, `unionReturn`, `contextsHaveProvSite`, `hasValueCollections`, `GENERIC_CTOR_NAMES`, the `void _bodyType` in `typeAfterSuffix`, `void BUILTIN_PACK_LATEST`, the dead `ThisRef.name` arm, `pagesInThisUi`, the dead `buildRef` guard in `expandCapability` + its contradictory docstring; O(n²) `hasExtern` recompute in `structural.ts:473`.
- **D4 (S)** Pluralisation copies in `lower-members.ts:410` / `lower.ts:782` delegate to `naming.ts`.
- **D5 (S)** `package.json`: move the triplicated exclude list into `vitest.config.ts`; drop the duplicate direct `chevrotain` pin (inherit Langium's).
- **D6 (S)** `emitsCommandRoute`/`collectLeaves` → `src/ir/util/` (the `page-kind.ts` precedent).
- **D7 (S)** `surface.ts` reserved hooks/slots (`:292-328`) — delete or implement the `?.` reads the comment claims; a versioned ABI shouldn't carry dead surface.
- **D8 (S)** Fix the contradictory capability-ref cloning docstring (`expander.ts:414` vs `:71`).
- **D9 (M)** Union monomorphization: canonicalize `unionInstanceName` on the set-based `typeKey` so `A or B` / `B or A` share one payload.

---

## Sequencing & dependency graph

```
Wave 0 (immediate, independent):  D1, A6.1, B5, B1, B26, B25, A8.5
Wave 1 (the big seams, parallel): A1 (→ B23)   A2 (→ A2.2)   A3 (→ A3.3, A5, C5-adjacent)   A4   A7.1–A7.3   A8.1–A8.4
Wave 2 (fixes riding seams):      B2–B4, B6–B8 (language)   B9–B16 (IR)   B17–B20 (gen)   B21–B22 (frontend)   B24 (system)
Wave 3 (contract + gate widening): A6.2, A6.3 (codify Wave-2 behavior), B23, remaining C-slices
Wave 4:                            A7.4 (fullstack-embed seam, own design doc), D-remainder
```

### Status (updated PR #1629)

Per the branch log, the following have **landed** (see the "Remediated in PR #1629"
addendum in the audit doc for the finding-level map):

- **Wave 0** — all landed (D1, A6.1, B5, B1, B25, B26, A8.5).
- **Wave 1** — A1, A2 (+A2.2), A3 (+A3.3), A4 landed. A7.1–A7.3 and A8.1–A8.4 landed
  too (see the 2026-07-05 code-verified update below — this line's "still open" was stale).
- **Wave 2** — B2–B4, B6–B24 landed (language / IR / generator / frontend / system fixes).
- **C-slices** — **C8, C9, C10, C13, C14 landed** in this PR; the remaining C mediums (C1–C7, C11, C12, C15) are open.
- **D-slices** — **D2–D9 landed** in this PR (D1 landed in Wave 0); the D set is complete.
- **Open** — A5, A6.2, A7.4, B23 (heex behavioral), and the C mediums above.

### Status (updated 2026-07-05 — code-verified against fresh `main`)

Re-derived every A7/A8 claim from the cited code, not the prose. The "A7.1–A7.3
and A8.1–A8.4 still open" line above was written mid-#1629 and is stale — the
whole A7 + A8 architecture tier has **landed**:

- **A7.1 — DONE.** `pipeline-layering.test.ts` carries `SIDE_EFFECT_RE`, scans
  `src/macros/` + `src/platform/**`, and handles dynamic `import()`.
- **A7.2 — DONE.** The pure-data leaf `src/platform/adapter-metadata.ts` exists;
  `lower-deployment.ts` + `platform-rules.ts` read it (no `registry`/generator
  import), pinned by `adapter-metadata-consistency.test.ts`.
- **A7.3 — DONE.** `WALKER_LAYOUT_PRIMITIVES` moved to
  `src/util/walker-primitive-names.js`; `walker-core.ts:68` imports it from
  `util/`, the language mirror + completeness test stay.
- **A8.1 — DONE.** Every `MigrationStep` carries `schema?`
  (`src/ir/types/migrations-ir.ts`).
- **A8.2 — DONE.** `migrations-builder.ts:506` drops in reverse-topological
  (child-first) order via `orderTablesByFkDependency(...).reverse()`.
- **A8.3 — DONE.** `MigrationDestructiveError` + `allowDestructive` /
  `--allow-destructive` gate (`src/system/index.ts`, `migrations-builder.ts`).
- **A8.4 — DONE.** `loom.duplicate-table` (`structural-checks.ts`).
- **A8.5 — DONE** (Wave 0). `SnapshotReadError` on a corrupt snapshot, no silent
  re-baseline (`src/system/snapshot.ts`).

**A6.3 — v1 landed** (the runtime-semantics contract): `docs/conformance-semantics.md`
+ the `test/conformance/semantics-rules.ts` registry + well-formedness gate, with
the three source-assertable rules gated per-PR (**RS-2** enum casing →
`enum-casing-parity.test.ts`; **RS-3** wire no-leak → `wire-no-leak-parity.test.ts`;
**RS-5** absence-match → the pre-existing `union-find-absence-parity.test.ts`).
The behavioral remainder (RS-1/4/6/7/8/9) rides **A6.2**.

**Genuinely still open:** **A5** (`WorkflowIR` still carries the `@deprecated`
`params`/`statements`/`savesAtExit` facade — `loom-ir.ts:1053`), **A6.2** (a booted
second backend in the per-PR behavioral tier — not docker-free: no in-process
Postgres for Python/SQLAlchemy), **A7.4** (fullstack-embed seam — deferrable,
own design doc), **B23**, and the C mediums.

**Rules of engagement** (per CLAUDE.md): every slice re-syncs on fresh `main` before starting and checks open drafts (parallel agents are landing PRs continuously — several B-slices are plausible collision targets); each slice opens a draft PR first naming its audit finding numbers; slices that change emitted bytes run the matching `LOOM_*` build gate locally before push; wire-shape-affecting slices (B13, B14, B18) call it out for the conformance-parity diff.

**Definition of done for the plan:** the audit's hostile-inputs fixture, walker property test, migrations repro suite, and validator fuzz gate are green in CI; every audit finding number appears in a merged PR body; `docs/audits/full-code-review-2026-07.md` gets a "remediated in" column appended rather than being rewritten (it's a snapshot).

---

## Effort summary

| Workstream | Slices | Rough effort |
|---|---|---|
| A (architecture) | 8 tracks / ~20 slices | ~5–6 engineer-weeks |
| B (high fixes) | 26 slices | ~4 weeks (heavily parallelizable after Wave 1) |
| C (medium) | 15 slices | ~2 weeks |
| D (housekeeping) | 9 slices | ~3 days |

Parallel-agent throughput changes the calendar math, not the ordering: Wave 1's four seams (A1–A4) should be **one agent each** (they touch broad file sets and would collide), while Wave 2 fans out safely because each slice is layer-local.
