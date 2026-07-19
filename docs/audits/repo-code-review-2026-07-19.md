# Full-repo code review — 2026-07-19 (second pass)

A second structured full-repo review of the Loom toolchain, run as a nine-slice
agent fan-out (one reviewer per architectural slice: language; macros + lower;
ir enrich/validate/types; TS+.NET backends; Elixir+Python+Java backends;
frontends + walker; system/cli/mcp/dap/platform/util; web/vscode/packages/scripts;
CI/hooks/harness). Each finding was confirmed by re-reading the surrounding code
and, where practical, reproduced by generating output — and for the Java runtime
bug, by booting the emitted jar against Postgres.

Snapshot: `main` @ `69f9b9b`. Like every file under `docs/audits/`, this is a
snapshot — **not** authoritative for what ships today. Verify against fresh
`main` before fixing.

## Relationship to the two prior audits

This pass was deliberately steered around ground already covered, and dedupes
against both:

- **`fleet-bug-hunt-2026-07-19.md`** (open PR #2081) — render-expr
  numeric/money/collection semantics, walker attr-escaping/`match`/`null`, Java
  Jackson-3, document optional-containment, wire constant-defaults,
  auto-versioning collision, scaffold money/`plural()`, Phoenix migration
  ordering. **No finding below overlaps it.**
- **`repo-code-review-2026-07.md`** (07-18, `main` @ `6748382`) — a ~96-finding
  whole-repo sweep. Two findings below **corroborate** it as still-live on fresh
  `main` (noted inline): **A1 = its L1** (inherited fields invisible to envs) and
  **the behavioral-runner gap = its CI4**. Everything else below is **new** —
  not present in that document.

The remaining ~13 findings are genuinely net-new. The confirmed product bugs are
being landed as individual small PRs off fresh `main`; the scorecard tracks each.

Severity legend: **build-break** — generated project fails its own compile gate;
**wrong-value** — compiles but serves incorrect results; **boot-break** —
generated stack fails to start; **security** — exposes protected data; **UX** —
cosmetic; **gate** — a CI/test weakness that lets a product bug ship green.

---

## Scorecard

| ID | Title | Severity | Disposition |
|----|-------|----------|-------------|
| C1 | `secret`/`internal` columns are accepted `?sort=` keys | security | LAND |
| E1 | Java `X id[]` `.contains` find 500s at runtime | wrong-value (runtime) | LAND |
| G1 | `ddd verify` false-VERIFIED off a suiteless duplicate-name result | wrong-value | LAND |
| C2 | Optional `derived` fields wrongly `required` in `wire-spec.json` | wrong-value (artifact) | LAND |
| D1 | TPH base reader omits `decimal.js` import (money-in-VO) | build-break | LAND |
| F2 | Four Vue/Svelte packs emit duplicate `style=` → user `style:` dropped | wrong-value | LAND |
| B1 | `saveResolver` not threaded to nested `computeSaves` → loop-body writes lost | wrong-value | LAND |
| E2 | Python emits `ruff`-failing code (F841/E713/F401) | build-break | LAND |
| H1 | Playground VFS seeder omits `angular/` → browser Angular gen throws | build-break (browser) | LAND |
| G4 | Distinct deployables collapsing to one `serviceSlug` collide silently | boot-break | LAND |
| B2 | Scaffold `workflowIsObservable` miscounts an optional id → phantom pages | wrong-value | LAND |
| G-dap1 | `samePath` single-key match → wrong-file breakpoints | wrong-value (latent) | LAND |
| A1 | Inherited aggregate fields invisible to type resolution (**= 07-18 L1, still live**) | build-break + fail-open | SURFACE |
| F1 | Angular/Feliz silently drop non-`extern` user components | content-drop | SURFACE (design) |
| I1–I4 | CI gate weaknesses (I1 = 07-18 CI4, still live) | gate | SURFACE |
| G2/G3/G5/H2/H3/A-min/dap2 | Low/latent/cosmetic | low | note only |

Disposition is updated as PRs land.

---

## C. IR enrich / types / util

### C1. `secret` and `internal` scalar columns are exposed as server-side sort keys — *security (ordering oracle over write-only data)*

`sortableFields` (`src/ir/util/sortable-fields.ts:23-38`) drops only `source==="id"`
and `access==="token"`; it does **not** drop `secret` or `internal`. Every scalar
`secret`/`internal` column therefore becomes an accepted `?sort=` key on all
backends (the helper is shared across every route/repo emitter). `forApiRead`
(`wire-projection.ts:36`) correctly keeps `secret`/`internal` *values* out of the
response, but `?sort=passwordHash&dir=asc` still orders rows by the hidden column
— a controllable ordering oracle (binary-searchable via pagination), defeating
the point of `secret` ("never disclosed in any read"). Reproduced: `crudish`
aggregate with `passwordHash: string secret` → `user-repository.ts` `sortColumns`
includes `passwordHash`. Not test-pinned. Fix: also `continue` on
`access === "secret"` and `access === "internal"` — the same set `forApiRead`
hides.

### C2. Optional `derived` fields are marked non-optional in `wireShape` → `wire-spec.json` declares them `required` — *wrong-value (contract artifact drift)*

`wireFieldsForAggregate` (`wire-projection.ts:341`), `…ForPart` (:381) and
`…ForValueObject` (:405) push every derived row with `optional: false`
unconditionally. A `derived label: string? = nickname` is nullable but enters
`wireShape` as `optional:false`; `wire-spec.ts:172` then lists it in `required`
and unwraps its type to a plain string — while every backend actually serves it
`nullish`. The contract artifact used for diff-based contract-change detection
disagrees with reality (false "contract changed" diffs; masks a real nullability
regression). Reproduced in `.loom/wire-spec.json`. Not test-pinned. Fix:
`optional: d.type.kind === "optional"` in all three `wireFieldsFor*`.

---

## D. TypeScript / Hono backend

### D1. TPH polymorphic base reader omits the `decimal.js` import when a concrete has money-inside-a-value-object — *build-break*

`base-reader-builder.ts:111` (drizzle TPH base reader) and `emit/mikroorm.ts:2469`
(MikroORM TPH base reader) gate the `decimal.js` import on
`concretes.some(aggregateUsesMoney)` — the *shallow* predicate
(`loom-ir.ts:3948`), which doesn't resolve a `valueobject`-typed field into the
VO's own fields. But the base reader's hydrate recurses into the VO and emits
`new Decimal(...)`. Import gate says "no money", body uses `Decimal` →
`TS2304: Cannot find name 'Decimal'`. The per-aggregate repository builder
already uses the VO-registry-aware `aggregateUsesMoneyDeep`
(`repository-builder.ts:287`); the two TPH base readers were never converted.
Reproduced by generating a TPH system with `price: Money`/`Money.amount: money`.
No TPH example/corpus fixture carries money-in-VO, so CI never compiles it.
(Distinct from the 07-18 audit's optional-VO Hono bug and the fleet's
document-containment bug — this is the TPH base-reader import gate.) Not
test-pinned. Fix: `concretes.some((c) => aggregateUsesMoneyDeep(c, ctx.valueObjects))`
at both sites.

---

## E. Elixir / Python / Java backends

### E1. Java `X id[]` membership find (`this.<refColl>.contains(x)`) 500s at runtime — *wrong-value (runtime crash)*

`render-jpql.ts:134-136` emits `:pokemon member of e.party`, where `party` is an
`@ElementCollection` of the embeddable id and the bind param is that same
embeddable. Hibernate 6 lowers `member of` to a tuple comparison and throws at
execution: *"Unsupported tuple comparison combination. LHS is neither a tuple nor
a tuple subquery but RHS is a tuple."* Verified live: generated the roster shape,
booted the jar against Postgres — create/read round-trips, but
`GET …/holding_in_party?pokemon=<id>` returns 500. This is the exact pattern
`examples/roster.ddd` advertises. `member of` compiles, so `bootJar`/`testClasses`
never execute it, and no corpus/behavioral fixture has an `X id[]` field. Elixir
(`join: assoc + where join_row.id == ^x`) and Python (correlated `EXISTS`) both
render it correctly — Java-only. Not test-pinned. Fix: a correlated existence
subquery on the override column instead of `member of`; add a corpus fixture with
an `X id[]` `.contains` find so the path is gated.

### E2. Python generator emits `ruff`-failing code for common shapes — *build-break*

Generated from `showcase.ddd`, `ruff check` fails on:
- **F841** (`workflows_routes.py:93`) — a workflow `let x = Repo.run(...)` whose
  result is unused emits `adhoc = await …` (assigned, never used).
- **E713** (`workflows_routes.py:60`) — a `.contains(…)` membership guard emits
  `if not ("x" in current_user.permissions):` instead of `not in`.
- **F401** (`seed.py:9`) — `datetime.UTC` imported but unused.

`ruff check` is the `python-build.yml` gate; not caught because `showcase.ddd`
isn't in the fixture set and no fixture hits these shapes. mypy `--strict` is
clean. Fix: bind the unused let to `_` (or drop it), emit `not in`, drop the
unused import.

---

## B. Macros + IR lowering

### B1. Mutating domain-service call inside a `for-each`/`if-let` body silently loses the write — *wrong-value*

`computeSaves` (`src/ir/lower/lower-members.ts:433`) detects `mutating`-tier
`domain-service-call`s only when a `saveResolver` is passed
(`lower-members.ts:403`). The resolver is threaded to every **top-level**
`computeSaves`, but the three **nested-body** calls — `for-each`
`savesPerIteration` (`lower-workflow.ts:554`), `if-let` `savesInThen` (598) /
`savesInElse` (603) — are made from `lowerWorkflowStatementInner`, which never
receives it. So a mutating service call on a body-local binding inside a loop
emits no `save` → the write is discarded. The identical loop with a direct
op-call persists correctly, so the two forms silently diverge. Not test-pinned.
Fix: thread `saveResolver` into `lowerWorkflowStatement`/`…Inner` and the three
nested `computeSaves` calls.

### B2. Scaffold `workflowIsObservable` counts an optional id state field the IR does not — *wrong-value (phantom pages)*

`_pages.ts:157` counts correlation-id candidates with
`p.type.base.$type === "IdType" && !p.type.array` (ignoring optionality), while
the IR (`lower-workflow.ts:151`) counts `f.type.kind === "id"` — an optional
`X id?` lowers to `{kind:"optional",inner:{kind:"id"}}` and is *not* counted. For
a workflow whose only id state field is optional, the scaffold emits
`InstancesList`/`InstanceDetail` pages hitting an instance endpoint the IR never
generates. Narrow. Fix: add `&& !p.type.optional` to the `idProps` filter.

---

## F. Frontends / walker

### F2. Vuetify / shadcnVue / flowbite / shadcnSvelte emit a duplicate `style` attribute → user `style:` silently dropped — *wrong-value*

When a primitive carries both a pack-styled prop *and* a user `style: { … }`, the
pack template hardcodes a literal `style="…"` and also splices the
walker-rendered `{{{styleAttr}}}` onto the same tag — two `style=` attributes; the
first wins per HTML rules, so the user's `style:` is discarded (and Vue/Svelte
compilers warn/mangle). Sites: `designs/vuetify/v3/primitive-container.hbs:1`, and
`primitive-heading.hbs:1` in `vuetify/v3`, `shadcnVue/v1`, `flowbite/v1`,
`shadcnSvelte/v1`; `renderStyleAttr` always emits a fresh ` style=`
(`vue-target.ts:422-435`, `svelte-target.ts:323-336`). Reproduced on a
Vuetify-retargeted landing page. React (merged `style={{}}`) and Angular (uses
`class`) unaffected. (Distinct from the 07-18 audit's F2, which is the Svelte
dynamic-style entity-escape bug.) Not test-pinned. Fix: merge the pack's fixed
declarations into `styleAttr` (one style attribute) or move them to a class.

### F1. Angular and Feliz silently drop non-`extern` user components — *content-drop (DESIGN DECISION — surface)*

A page/component body invoking a user-defined (non-`extern`) `component` renders
as an inert comment on Angular (`angular/index.ts:158-169`) and Feliz
(`feliz/index.ts:803-812`) — both thread only `extern` components into the
walker's `userComponents` map; the missing component falls through to the
"unknown layout component" comment (`walker-core.ts:978`). React, Vue, Svelte,
Flutter all render it. The Angular source comment documents this as a known
limitation, so it is intentional — but from the user's perspective it is a
**silent content-drop** with no diagnostic. Flutter user components landed
recently (#2109), so the per-frontend rollout is in progress. **Recommendation:
add a `loom.*` IR-validator gate rejecting a non-extern component invocation on an
Angular/Feliz UI** so the gap is honest, not silent — or finish threading
non-extern components through both backends. Left as a design call for a human.

---

## G. system / cli / verify / platform / dap

### G1. `ddd verify` marks requirements VERIFIED off a single suiteless result — *wrong-value (false green DoD)*

`outcomeFor` (`src/verify/verification.ts:53-56`, the bare-name fallback) promises
in its own comment to attribute a suiteless result "only when it can't be confused
with another test of the same name," but applies no uniqueness check — it returns
`worst(named.filter(suite===undefined))` for *every* `ExecTestRef` whose `name`
matches, and `outcomeFor` isn't even given the ref set to check against. Two
aggregates each declaring `test "create works"` (verifying different
requirements) + one suiteless `{"name":"create works","status":"pass"}` row →
**both** requirements VERIFIED, though only one test ran. Gates
`--require-all`/`--min`. Reachable (`TestOutcome.suite` is optional; the CLI feeds
`parsed.results` verbatim). Not test-pinned (`verification.test.ts:95` only feeds
suite-carrying results). Fix: pass the name-collision set into `outcomeFor` and
refuse the suiteless fallback when >1 `ExecTestRef` shares that name.

### G4. Distinct deployables that collapse to the same `serviceSlug` collide silently — *boot-break*

`serviceSlug` (`src/system/index.ts:543-545`) lowercases, so two case-distinct
deployable names (`Web`/`web`, `webApi`/`WebApi`) produce the same output subdir,
compose service, and `CREATE DATABASE <slug>` — output files silently overwrite,
compose merges the two services, and the duplicated `CREATE DATABASE` fails on
first boot. Only case-sensitive *name* uniqueness is validated; no slug-uniqueness
gate. Pathological naming required. Fix: add a validator rejecting deployables
whose `serviceSlug` collides.

### G-dap1. `samePath` single-key `matchPath` defeats ambiguity detection → wrong-file breakpoints — *wrong-value (latent)*

`samePath` (`src/dap/breakpoints.ts:62-64`) calls `matchPath(dddPath, [sourcePath])`
with a single-element key list. `matchPath` (`resolve.ts:108-133`) only returns
`undefined` on a *tie across multiple keys*, so with one key any shared trailing
segment (same basename) matches. For a project with two `.ddd` sources sharing a
basename (`orders/main.ddd` + `payments/main.ddd`), a breakpoint on
`orders/main.ddd:15` matches `payments/main.ddd` regions, then compares a
`payments` byte offset against a byte range computed from `orders`' text
(`breakpoints.ts:130-131`) — two coordinate systems. `resolveFrame` is safe (it
passes the full key set). Latent (single-file is the norm). Not test-pinned. Fix:
require a full-segment / exact-suffix match in `samePath`.

*Lower (note only):* G2 `symbol-resolver` picks the first node on an `addressOf`
collision instead of returning `ambiguous` (`api/symbol-resolver.ts:133`, only
bites already-invalid models); G3 `agent-loop` reports `stoppedBy:"end_turn"` on a
`max_tokens` stop (`tools/agent-loop.ts:154`); G5 `gaps.md` doesn't flag a
requirement absent (`undefined`) vs `null` (`traceability.ts:224`, derived doc);
G-dap2 a column that misses every fine region drops the annotation when no coarse
sibling exists (`resolve.ts:196-217`, depends on an emitter invariant).

---

## H. web / playground

### H1. Playground VFS seeder omits the `angular/` shared-template dir → Angular generation throws in the browser — *build-break (browser)*

`web/src/build/template-bundled.ts:47-56` (`sharedSources` glob) and `:95`
(`parseSharedPath` regex) enumerate `vite|api|docker|sveltekit|vue` — **`angular`
is missing from both**, though the browser pack loader expects it
(`loader-vfs.ts:46` → `angular: ["/angular/","/api/"]`). An Angular-format pack
loaded in the worker finds nothing under `/angular/`; the Angular generator then
calls `pack.render("index-html")`/`"dockerfile"`/`"dockerignore"`
(`angular/index.ts:355,431,432`) and `render()` **throws**
`no template registered for "index-html"` (`_packs/loader.ts:374`). User picks
`platform: angular` + `design: angularMaterial` → hard error, no output. The
CLI/fs path works (reads `angular/` off disk). `vue` and `sveltekit` are seeded
correctly — Angular was an oversight when added. Not test-pinned. Fix: add
`angular` to the `sharedSources` glob and the `parseSharedPath` alternation.

*Lower (note only):* H2 `loader-vfs` shared-dir listing is recursive while
`loader-fs` is flat (latent browser/CLI divergence if a `.hbs` is ever nested);
H3 `loader-vfs.loadPack` never forwards `validateRequired` to `compilePack`.

---

## A. Language front-end (corroborates 07-18 audit L1)

### A1. Inherited aggregate fields are invisible to the type-system env & member resolution — *build-break on valid input + silent fail-open (STILL LIVE)*

The 07-18 audit's **L1** — re-verified live on `main` @ `69f9b9b` via the CLI, so
it has **not** been fixed. `envForAggregate` (`validators/_shared.ts:58`),
`addEntityMembers` (`type-system.ts:1415,1532`), `lookupRootMember` (:1296),
`stepInto` (:1314), `lookupEntityMember` (:855) iterate only `agg.members`, not
`agg.superType?.ref`; `aggregateChainHasMember` (:951) *does* walk the chain, so
the unknown-member check is correct while type-resolution is not. Symptom A: a
subtype operation assigning to an inherited field by bare name is flagged
`Cannot resolve` (and `this.x := …` doesn't parse, so there is no valid way to
mutate inherited state). Symptom B: `derived bad: bool = score == name`
(int==string over inherited fields) is not flagged (fail-open). Not test-pinned.
Fix: a shared `superType`-chain member iterator in the env builders and lookups.
Surfaced (corroboration) — landing left to the owner of the 07-18 L1/L2/L3
member-lookup consolidation, since the clean fix is one shared helper across
~6 sites (07-18 L1–L4) rather than a point patch.

---

## I. CI / test-harness gate weaknesses

- **I1 (high-gate; = 07-18 CI4, still live):** the behavioral e2e runner
  (`test/behavioral/run.mjs`) exits non-zero only on `fail/errored/reqFailing > 0`
  — no floor asserting a case with a `test e2e` block produced >0 api results, so
  an emitted-but-empty suite is double-green (the emission gate,
  `behavioural-coverage.test.ts:46`, asserts only that the file exists). Fix:
  assert emitted case-count == source `test e2e` count and fail a tier that yields
  0 for a source that declares it.
- **I2 (med-gate):** 0 of 30 corpus fixtures carry a domain `test "…"` block; the
  unit tier is exercised by ~one system. Partly deliberate (documented Phase-4).
- **I3 (med-gate):** `corpus-build.yml:26` omits Elixir from the per-PR corpus
  compile matrix; breaks surface only post-merge. Semi-deliberate.
- **I4 (low-gate):** the corpus shard tests (`corpus-tsc-build.test.ts:34` +
  siblings) pass vacuously green on a mistyped `LOOM_CORPUS_*_CASE` (contrast
  `generated-react-build.test.ts:159`, which throws). Latent. Fix: throw on
  no-match.

---

## Checked and clean

The reviewers traced and cleared large surfaces: the shared `_expr/target.ts`
dispatch + recursion; Hono paged routes / sort whitelisting / pagination; `.NET`
EF/Dapper repositories (paged sort, CAS, ES stream conflict); `seed.ts`; MikroORM
entity/filter emission; the migrations-builder (FK ordering,
rename/backfill/reshape cascades, TPH/TPC/embedded/document/eventLog shapes,
destructive-policy gate); system compose (ports/env/healthchecks/DB isolation);
snapshot/baseline re-baseline guards; CLI generate/patch/snapshot dry-run
fidelity; platform registry/metadata/frontend-dispatch; sourcemap V3 VLQ
encoding; zod-schema emission (matches wire projection); Playwright page-object
selectors; the `packages/*` `loom`-key discovery; the `web/` semver + DDL runtime;
and the three `.claude/` hooks (fail-open by design). Java `bootJar` and Python
`mypy --strict` are green on `showcase.ddd` + 11 corpus fixtures.
