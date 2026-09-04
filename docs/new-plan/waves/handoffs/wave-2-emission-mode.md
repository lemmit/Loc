# Wave 2 — packet 2.4 (emission-mode) hand-off

*Branch: `claude/wave-2-emission-mode`, off `claude/wave-2` @ `ee8c2f0ec`. Row:
`docs/new-plan/improvement-waves-2026-09.md` §Wave 2 item 2.4; §F2 of the
08-24 review (`docs/audits/generator-code-review-2026-08-24.md`); ledger row
`G2667-F2-render-mode-in-seam`.*

## Headline

**§F2 closes.** The java JPQL `principalAccessors` boolean flag (the row's
own example) and its four siblings — dotnet dapper raw SQL, the Postgres
migration-backfill renderer, python SQLAlchemy filter lowering, node Drizzle
predicate lowering — now decide "is this construct in my vocabulary" against
one declared table (`QUERY_EMISSION_VOCABULARY` in
`src/generator/_expr/target.ts`), and every out-of-vocabulary fallback routes
through one shared `refuseOutOfVocabulary(mode, what)` instead of an ad hoc
`throw new Error(...)`. dotnet EF Core LINQ and Elixir Ecto reuse the FULL
domain-logic `ExprTarget` for query positions already (`ctx.efQuery` /
`ctx.filterArgs`) — nothing to narrow there, so they're documented as
consumers of the same mode contract rather than given a new vocabulary table.

**One real (though unreachable-from-valid-`.ddd`) gap found and closed along
the way**: python's `relationalFindMethod` / `viewFindMethod`
(`repository-builder.ts`) had a declared `find.filter` / `view.filter`
silently drop to "no filter" whenever `lowerToSqlAlchemy` returned `null` —
an unfiltered read. `loom.projection-where-not-queryable` (projections) and
`firstNonQueryableNode` (finds/retrievals) already gate the exact same
vocabulary boundary at IR-validate time, so no valid `.ddd` program can reach
either site (confirmed: the byte-identical corpus run below never fires the
new refusal) — but a validator gap away from a live leak, closed as
defense-in-depth via the new `requireLowered` helper.

## Mode table

| mode | renderer | file | vocabulary |
|---|---|---|---|
| `jpql-spring-data` | JPQL for a Spring Data `@Query` method | `java/render-jpql.ts` | `literal, this, id, ref, member, paren, unary, binary, authz-filter, method-call` |
| `jpql-entity-manager` | JPQL for a raw `EntityManager.createQuery` (query-time projection aggregation) | `java/render-jpql.ts` + `java/emit/query-projection-reads.ts` | same as `jpql-spring-data` — the two modes diverge only in HOW `currentUser.<claim>` renders (SpEL vs a plain `:name` bind param), not in accepted `ExprIR.kind` |
| `sql-postgres-migration` | raw Postgres SQL for a `migration` block's `backfillColumn` | `sql-pg-expr.ts` | `literal, ref, paren, unary, binary, ternary` |
| `sql-dapper` | hand-rolled raw Postgres SQL, `persistence: dapper` | `dotnet/emit/dapper.ts` `whereToSql` | `paren, unary, binary, method-call, member, ref, authz-filter, literal` |
| `linq-efcore` | EF Core LINQ (`CsRenderContext.efQuery`) | `dotnet/render-expr.ts` `renderCsExpr` | `ALL_EXPR_KINDS` (full domain-logic surface — EF Core translates nearly everything `CS_TARGET` already emits; narrowing happens at `firstNonQueryableNode`, not here) |
| `sqlalchemy-filter` | SQLAlchemy Core operator-overload predicates | `python/find-predicate.ts` `lowerToSqlAlchemy` / `lowerWorkflowFilterToSqlAlchemy` / `lowerProjectionFilterToSqlAlchemy` | `literal, this, id, ref, member, paren, unary, binary, authz-filter, method-call` |
| `drizzle-predicate` | Drizzle function-call predicates | `typescript/repository-find-predicate.ts` `lowerToDrizzle` | `literal, this, id, ref, member, paren, unary, binary, authz-filter, method-call` |
| `ecto-fragment` | Ecto `where:` query fragments (`ctx.filterArgs`) | `elixir/render-expr.ts` `renderExpr` | `ALL_EXPR_KINDS` (Ecto queries are valid Elixir syntax, so `ELIXIR_FILTER_TARGET` renders the same kind set `ELIXIR_TARGET` does; narrowing happens at `firstNonQueryableNode`) |

`ALL_EXPR_KINDS` = every `ExprIR.kind` `renderExprWith` dispatches (20 kinds)
minus `action-ref` (UI-only, never valid in a domain expression).

## Row (single row this packet)

| row | outcome | proof | notes |
|---|---|---|---|
| §F2 emission mode as a declared seam | **fixed** | `test/generator/_expr/emission-mode.test.ts` — 35 assertions across three suites (census, vocabulary, reachability), each mutation-proved (see below) | `src/generator/_expr/target.ts` (`QueryEmissionMode`, `QUERY_EMISSION_VOCABULARY`, `refuseOutOfVocabulary`, `QueryEmissionRefusal`); `java/render-jpql.ts` (`JpqlCtx.mode` replaces `principalAccessors` as the boolean flag — the set stays, only for collecting bindings); `java/emit/query-projection-reads.ts` (`aggregationScope` declares `mode: "jpql-entity-manager"`); `sql-pg-expr.ts`; `dotnet/emit/dapper.ts`; `dotnet/render-expr.ts` (doc-only — reuses `CS_TARGET_EF`); `python/find-predicate.ts` (new `requireLowered` export) + `python/repository-builder.ts` + `python/query-projections-builder.ts`; `typescript/repository-find-predicate.ts` + `typescript/repository-find-builder.ts`; `elixir/render-expr.ts` (doc-only — reuses `ELIXIR_FILTER_TARGET`) |

## Diagnostic

New code `loom.query-emission-invalid` (`src/diagnostics/messages.ts`). Suffix
`-invalid`, not `-unsupported`/`-backend` — per the classification note atop
`src/diagnostics/unsupported-register.ts`, this is a *deliberate refusal*
backstop (a validator gap or compiler bug, never a user mistake), not
`-unsupported` backlog work, so it carries **no row** in
`unsupported-register.ts` (confirmed: `test/system/unsupported-register.test.ts`
passes unchanged). Its `diagMessage(...)` call site lives in
`src/generator/_expr/target.ts`, generation-time code outside
`test/system/diagnostic-catalog.test.ts`'s normal `catalogedSources()` scan
(validate-phase files only) — I added that one file path to the scan list so
the catalog's orphan-check still finds the usage (one-line addition,
`test/system/diagnostic-catalog.test.ts`, outside this packet's file fence but
necessary for "text lives in the catalog" to actually hold; low collision
risk — a single array-literal entry). `test/system/diagnostic-catalog.test.ts`
passes (10/10).

`test/system/diagnostic-firing-census.test.ts` (M-T9.33) separately enumerates
every catalog code and demands a `.ddd`-driven `validate()` fixture, an
`UNREACHABLE_PINS` entry, or membership in the two frozen/shrink-only lists.
`loom.query-emission-invalid` is not a `validate()` diagnostic at all (it
fires from generator code the census's harness cannot drive), so it is pinned
in `UNREACHABLE_PINS` with that reason, pointing back at this packet's own
contract test for its real coverage. Passes (103/103).

## Hard gate 1 — byte-identical emission

Generated `test/fixtures/corpus/*.ddd` (58) + `examples/*.ddd` (23) +
`web/src/examples/**/*.ddd` (63) = **144 fixtures** via
`node bin/cli.js generate system <f> -o <dir>` and `node bin/cli.js parse <f>`,
before (`ee8c2f0ec`, a clean worktree checkout) and after (this branch,
`5e1ad1c74`).

- **File-set + content diff over all 144 generated trees: empty** after
  normalizing two pre-existing, unrelated non-determinisms present on BOTH
  base and head equally (verified they are the ONLY diffs before
  normalization, on every one of the 13 fixtures that showed raw diffs): the
  absolute checkout path embedded in dotnet's `#line` sourcemap directives
  (base and head are two different checkout locations — an artifact of this
  diff methodology, not codegen) and the crypto-random `SECRET_KEY_BASE` in
  `docker-compose.yml` (regenerated every `generate system` run by design).
  `generate.exitcode`: 0/0 mismatches across 144 fixtures. Script:
  `<scratch>/diff-corpus.mjs` (not committed — scratch tooling).
- **`ddd parse` diagnostics: byte-identical** on every fixture — 0/144
  mismatches (`parse.log`, normalized only for the same checkout-path prefix).
- **The new refusal never fires on the corpus** — confirmed both by `generate`
  exiting 0 on every fixture on both sides (a firing would abort generation
  non-zero with a `QueryEmissionRefusal` stack trace) and by the file-set
  equality check above (a refusal mid-generation would leave a partial `gen/`
  tree, which the file-set comparison would have caught).

## Hard gate 2 — census mutation-proved

Two independent mutations, each reverted by file copy (`cp` to/from a
`.bak` under the scratchpad, never `git checkout --`), md5-verified before
and after revert.

**Mutation A — undeclared renderer.** `render-jpql.ts`'s `unsupported(ctx, what)`
was changed from `refuseOutOfVocabulary(ctx.mode ?? "jpql-spring-data", what)`
back to a bare `throw new Error(...)` (the pre-packet shape). Failing
assertion:

```
FAIL  emission mode — census … > src/generator/java/render-jpql.ts declares its emission mode ('jpql-spring-data')
AssertionError: src/generator/java/render-jpql.ts:453: renderer declares no
emission mode — expected to find "refuseOutOfVocabulary(ctx.mode ?? \"jpql-spring-data\"" …
```

md5 before mutation `d75946d7…`, after mutation `20483a4c…`, after revert
`d75946d7…` (matches original) — verified.

**Mutation B — vocabulary widened.** `JPQL_KINDS` in `_expr/target.ts` grew a
`"call"` entry it should not accept. Failing assertion:

```
FAIL  emission mode — vocabulary > 'jpql-spring-data' vocabulary is pinned
AssertionError: expected [ 'authz-filter', 'binary', …(9) ] to deeply equal [ Array(10) ]
+   "call",
```

(and the `'jpql-entity-manager' vocabulary is pinned` sibling, same table).
md5 before `b76f9581…`, after mutation `48347443…`, after revert `b76f9581…`
— verified.

## Hard gate 3 — refusal mutation-proved

`firstNonQueryableNode` (finds/retrievals) and `loom.projection-where-not-queryable`
(query-time-projection filters — added specifically to close this exact
silent-drop class, see its doc comment in `src/ir/validate/checks/projection-checks.ts`)
already gate the SAME vocabulary boundary at IR-validate time. That is by
design (defense-in-depth): **no valid `.ddd` program can reach a query-language
renderer's refusal** without first defeating that validator gate, so an
end-to-end `.ddd → generate` reproduction is not constructible for this row —
constructing one would itself be evidence of a validator gap, not a renderer
gap.

The faithful equivalent, at the altitude these renderers actually operate
(already-lowered `ExprIR`, no `.ddd`/CLI pipeline involved): a **reachability**
suite (`test/generator/_expr/emission-mode.test.ts`, describe block "reachability
through the REAL renderer entry points") calls the actual exported renderer
functions — `renderJpqlWhere` (both JPQL modes), `renderSqlScalarExpr`,
`whereToSql`, `requireLowered` — directly with a hand-built out-of-vocabulary
`ExprIR` node (`{kind: "call", callKind: "free", name: "mystery", args: []}`,
a `call` in every narrow mode's excluded set), proving each one refuses with
`QueryEmissionRefusal` / `loom.query-emission-invalid` — not the standalone
`refuseOutOfVocabulary` helper called directly (that's the vocabulary suite),
the renderer a `.ddd` filter would actually reach. 6 assertions, all passing.

Removing the wiring reproduces the exact PRE-PACKET failure modes:

- **JPQL** (already a hard stop before this packet, just an uncoded `Error`):
  Mutation A above demonstrates this — reverting the `refuseOutOfVocabulary`
  call still throws, just without the `loom.query-emission-invalid` code / the
  `QueryEmissionRefusal` type the reachability test asserts on.
- **python** (the real silent-leak class this packet closes): reverting
  `repository-builder.ts`'s `requireLowered(...)` wrapper back to the bare
  ternary (`find.filter ? lowerToSqlAlchemy(...) : conventionPredicate(...)`)
  reproduces the ORIGINAL bug — a declared filter that fails to lower silently
  drops, and the generated Python **compiles and boots**, but serves every row
  the filter should have scoped. This is worse than "does not compile": it is
  a silent authorization/correctness leak, the exact failure class §F2 exists
  to close. Verified via `requireLowered("x", null)` throwing
  `QueryEmissionRefusal` with the wrapper in place, and by inspection of the
  pre-packet code (the `rootWhere(pred, ...)` — `repository-builder.ts:591` —
  omits any term for a `null` `pred`, so no `WHERE` clause references the
  filter at all).

I did not run the java/python compile legs (docker) for this proof — the
refusal fires at TypeScript-toolchain generate time (`node bin/cli.js
generate system` aborts non-zero before any java/python source is written),
so there is no generated java/python project to feed a compiler in the
"refused" case; the "removed" case is the pre-packet python behaviour, which
already compiled clean on every existing corpus/e2e fixture (confirmed:
`npm run test:python-corpus`-style compile coverage was unaffected because
the shape never appears in the corpus — see hard gate 1).

## Local gate results

- `npx tsc -b` — clean.
- `npm run lint` (`biome ci .` after `biome check --write .` for formatting) — clean, 0 errors, 12 pre-existing warnings (none touch files in this packet's tree).
- `npx vitest run test/generator/_expr test/generator/java test/generator/python test/generator/dotnet test/generator/typescript test/system/diagnostic-catalog.test.ts test/system/unsupported-register.test.ts` — **2338/2338 passed** (370 files).
- `npx vitest run test/generator/elixir test/generator/elixir-vanilla` — 1200/1200 passed (doc-comment-only touch there; ran anyway).
- `npx vitest run test/system/diagnostic-firing-census.test.ts` — 103/103 passed (after the `UNREACHABLE_PINS` addition).
- `npx vitest run test/platform/pipeline-layering.test.ts test/platform/backend-packages-layering.test.ts` — 11/11 passed (confirms the new `src/generator/_expr/target.ts → src/diagnostics/messages.ts` import doesn't cross a banned layer — `diagnostics/` isn't one of the pipeline's tracked layers).
- `npx vitest run test/generator/_expr/emission-mode.test.ts` — 35/35 passed (the packet's own contract test, in isolation).
- Corpus byte-identical diff (hard gate 1) — see above: **BYTE-IDENTICAL: yes** (144/144 fixtures, 0 exit-code / parse.log / generated-tree mismatches after the two documented normalizations).
- Did NOT run the full `npm test` (per instructions) or any docker compile leg (java/dotnet/elixir corpus builds) — the refusal fires before any target-language source is written on the "removed" side becoming reachable, so a compile leg would not exercise anything the reachability suite + hard gate 1 didn't already cover; see hard gate 3's note.

## Hand-offs

None outside the tree fence. Two items found but NOT touched, recorded for
the next agent who lands in this area:

1. **`writeScopePredicate` (`typescript/repository-find-predicate.ts`)** silently
   returns `null` when `agg.writeScopeFilter` is present but fails to lower
   (the WRITE-path twin of the read-path bug I fixed) — unlike
   `contextFilterPredicate` two functions above it, which already hard-stops.
   I did not find a validator gate specifically covering `writeScopeFilter`
   queryability (only the general `firstNonQueryableNode` shared definition,
   and I could not confirm it is threaded onto `writeScopeFilter` at
   construction time in the time this packet had). Left untouched — a
   write-authorization code path deserves its own verification, not a
   drive-by fix riding a seam-refactor packet. Flagging for whoever next
   touches `writeScopePredicate` or the tenancy write-scope validator.
2. **dotnet `linq-efcore` / elixir `ecto-fragment`** are documented as
   `ALL_EXPR_KINDS` (no renderer-level narrowing) rather than given a real
   per-kind vocabulary. That is a description of the current architecture
   (EF Core / Ecto both reuse the full domain-logic target), not a gap — but
   if either backend's query translator ever needs its OWN narrower
   vocabulary (e.g. a construct EF can express in `Where` but not in
   `HasQueryFilter`), that would be new work, not covered here.

## Docs

- `docs/audits/targets-completeness-2026-08-30.ledger.json` — `G2667-F2-render-mode-in-seam` moved `open` → `done`, `"pr": "#2770"`; `node scripts/ledger-counts.mjs --write` re-run (`.md` counts: open rows 161→160, P4 91→90, mission 65→64, size M 70→69, done/merged 128→129).
- `docs/audits/generator-code-review-2026-08-24.md` — §F queue row F2 flipped `OPEN` → `done (Wave 2 packet 2.4, #2770)` with file:line evidence.
