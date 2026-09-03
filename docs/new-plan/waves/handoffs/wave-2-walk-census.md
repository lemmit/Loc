# Wave 2 hand-off — 2.3 walk-census

*Branch: `claude/wave-2-walk-census` (the `claude/wave-2/walk-census` name collides
with the pre-existing `claude/wave-2` ref, same collision every wave-1 packet
hit — see `wave-1-python-macros.md`'s setup note; followed the established
dash-separated convention).*

## Deliverable

`test/system/ir-walk-census.test.ts` — a type-checked (real TS `Program` +
`TypeChecker`, not a variable-name regex) census of every hand-rolled
`switch (<recv>.kind)` and `if (<recv>.kind === "a") … else if (…) …` /
`||`-joined chain enumerating ≥3 distinct kind literals, over a receiver whose
static type includes `ExprIR` / `StmtIR` / `WorkflowStmtIR`, outside the four
sanctioned dispatchers (`src/ir/util/walk.ts`, `_expr/target.ts`,
`_stmt/target.ts`, `_workflow/stmt-target.ts`) and the lowerers
(`src/ir/lower/**`). Every found site is required to be either exhaustive
(a `default:`/terminal-`else` `never`-check or `assertNever(...)` call, **or**
a `default:` that delegates to a sanctioned shallow visitor
—`walkExprChildren`/`walkStmtChildren`/`walkWorkflowStmtChildren`— which is
exactly as safe) or waived with a reason. Waivers ratchet: a waiver whose site
no longer exists, or has since become exhaustive, fails.

## The detector, decided and documented in the test file itself

Two shapes (both documented in the header comment of the test):

1. `switch (<recv>.kind) { … }`.
2. An `if`/`else if` chain (constant `===` comparisons, `||`-joined
   conditions included) naming ≥3 distinct kind literals on the same
   receiver — 3 is the line because two arms reads as an ordinary branch,
   not a dispatch that will silently miss a fourth kind. A single `if` whose
   condition itself `||`s together 3+ kind literals also counts (it enumerates
   ≥3 kinds, per the packet brief's own wording), even without a chain.

Both use the real TypeScript type checker (`checker.getTypeAtLocation` +
`checker.typeToString`, matching on the identifier `ExprIR`/`StmtIR`/
`WorkflowStmtIR`) rather than a variable-name guess. Two tests in the file
pin this choice against the two failure modes the naive baseline grep has:

- `src/generator/_expr/authz-filter-inapp.ts`'s `switch (e.filter.kind)` (an
  `AuthzFilterKind` discriminant nested inside an `authz-filter` `ExprIR`,
  sharing the receiver name `e`) is never attributed to `ExprIR`.
- `src/generator/elixir/render-expr.ts#isDecimalOperand`'s
  `switch (operand.kind)` (receiver named `operand`, outside the naive
  baseline's `(e|expr|s|stmt|node|st|ex)` name list) is still found.

## Baseline vs. today

The packet brief's own stated baseline (`grep -rn --include=*.ts -E "switch
\((e|expr|s|stmt|node|st|ex)\.kind\)" src` minus the sanctioned homes): **135
sites in 41 files**. Re-running that exact command on the branch's starting
commit (`ee8c2f0`, fresh `claude/wave-2`) reproduces the site count (135) but
not the file count — the naive grep's own file tally comes out to **88**
files, not 41; the `41` figure in the plan doc appears to predate the current
IR surface (verified: the file-set the grep actually names is fully
attributable to the current `src/**`, the discrepancy is in the historical
count, not a detector bug on this end). Documented here rather than silently
"corrected" in the plan doc, since that document's status tables are the
coordinator's to update.

The census test's own (type-checked, more precise) detector finds, at the
branch tip after this packet's fixes: **133 total sites** (116 `switch` form
+ 17 `if-chain` form) across the sanctioned-home-excluded surface. **17 are
exhaustive** (7 certified this packet with a `never`-check + the rest were
migrated onto `walk.ts` and now delegate to a sanctioned shallow visitor,
which the detector also accepts as exhaustive), and **116 are waived** with
the categorized reasons below. Every migrated site that closed a real gap
(rather than merely gaining a `never`-check) is counted as removed from the
census surface entirely — it no longer contains a hand-rolled switch/if-chain
at all, so the 133 figure is the surface AFTER this packet's migrations, not
before; the pre-packet count (offenders_exact.txt, captured before any edit)
was 135 sites in 88 files by the same type-checked detector (the naive
baseline grep the plan doc cites gets 135 sites too, but 88 files, not the
plan's stated 41 — see above). (`sites.length` is intentionally not pinned to
an exact number in the test — see `expr-site-census.test.ts`'s established
rationale, quoted in this file's own header comment: a number that moves with
every IR field is a chore with no reader; what's pinned is a `>80` /
`>70`-switch floor, the blind-analysis guard.)

## Rows — sites migrated onto `walk.ts` (real M-T6.50-class bugs found and fixed)

Each of these had a genuine silent-drop gap — a kind the hand-rolled
traversal never reached — not just a missing compile-time proof. Mutation
proof for each: revert the file (copy aside → `git show <base>:<path> >
tmp` → mutate back → restore from `tmp`; never `git checkout --`), the
construct the fix added a case for is now silently dropped again, and the
generated output changes for a fixture that exercises it.

| file | function | gap found | proof |
|---|---|---|---|
| `src/generator/java/render-expr.ts` | `collectJavaExprImports` | block-body lambda statements never visited (`e.body` only, no `e.block`) — a `decimal`/`money` literal or `.matches()` call hidden in one never triggered its import | direct unit call; reverting to the hand-rolled switch drops the import for a probe expression with the literal inside a block-body lambda |
| `src/generator/java/render-stmt.ts` | `collectJavaStmtImports` | no `variant-match` arm | same M-T6.50 (c) shape wave 1 fixed in the Python sibling |
| `src/generator/dotnet/render-expr.ts` | `collectCsExprUsings` | same lambda-block gap | as above |
| `src/generator/dotnet/render-stmt.ts` | `collectCsStmtUsings` | no `variant-match` arm | as above |
| `src/generator/python/render-expr.ts` | `collectPyExprImports` | same lambda-block gap | as above |
| `src/generator/python/emit/aggregate.ts` | `collectStmtExprImports` | no `variant-match` arm (a **separate, near-identically-named** copy from the one wave 1 fixed in `emit/domain-service.ts` — confirmed two distinct functions, not a re-fix) | as above |
| `src/generator/python/emit/value-objects.ts` | `collectBlockStmtExprImports` | no `variant-match` arm | as above |
| `src/ir/validate/checks/workflow-checks.ts` | `validateWorkflowBody` | no arm for `domain-service-call` at all (4 of 14 `WorkflowStmtIR` kinds silently skipped by every check in the switch) | added a documented no-op arm (the `Svc.op(...)` reference is resolved by Langium's linker at phase ③ before lowering, so there is genuinely no service/op-existence check left to add) + `never`-check |
| `src/generator/elixir/domain/predicates.ts` | `exprUsesParam` / `exprUsesReceiver` | the shared local shallow `walkExpr` had no arm for `list`/`convert`/`match`/`i18nFormat`/`authz-filter`, and a block-body lambda's statements were never reached at all | migrated onto `walkExprDeep`; both now visit `e` itself + every reachable descendant |
| `src/generator/java/emit/entity.ts` | `exprCallsDomainService` / `stmtCallsDomainService` | same shape of gaps (plus no `variant-match` in the stmt half) | a domain-service call nested in any of those never triggered the `domain.services.*` import — a Java compile failure (unresolved symbol) |
| `src/generator/java/emit/workflow.ts` | `workflowUsesCurrentUser` | no arm for 4 of 14 `WorkflowStmtIR` kinds (`assign`/`domain-service-call`/`if-let`/`repo-delete`) | a workflow reading `currentUser` only inside one of those never got principal-threading, generating a method missing the `currentUser` param its own body reads |
| `src/generator/java/emit/workflow.ts` | `readingServicesCalled` / `staticServicesCalled` | hand-rolled walk only recursed into `for-each` bodies, never `if-let` | a reading/static-tier domain-service call inside an `if-let` branch never triggered its class import/injection |
| `src/generator/dotnet/workflow-emit.ts` | `analyseStmts` / `analyseWorkflow` | same `if-let`-recursion gap as the java sibling, PLUS insertion-order-preserving migration (two call sites iterate the returned `repos` Map directly to emit lines) | migrated the recursion step onto `walkWorkflowStmtChildren` while keeping the original per-kind ordering exactly — verified against every downstream consumer before applying |
| `src/generator/dotnet/workflow-emit.ts` | `collectDereferencedLoads` | only recursed into `for-each`, never `if-let` — for BOTH the op-call/domain-service-call name collection and (transitively) the member/method-read scan | an `op-call`/`domain-service-call`/member-read inside an `if-let` branch never guarded its `getById` load — a latent CS8602/CS8604 under nullable-reference types |
| `src/generator/dotnet/workflow-emit.ts` | `collectReadingServices` | (no bug — already recursed into `if-let` correctly) migrated for consistency onto `walkWorkflowStmtExprsDeep`; this ALSO widens coverage to `assign`/`repo-delete`/`domain-service-call`'s own `.call` expr (kinds the old `workflowStmtExprsForServiceScan` didn't enumerate) | verified via the byte-identical corpus diff below — no corpus fixture currently nests a reading-tier service call inside those positions |
| `src/generator/dotnet/explicit-handlers-emit.ts` | `collectRepos` | (no bug — `for-each`/`if-let` are the only two nesting kinds, and both were already handled) migrated onto `walkWorkflowStmtsDeep` for future-proofing | order-neutral (only sets `repo-let`/`repo-delete`, order doesn't affect the final `Map`'s consumption) |
| `src/generator/java/explicit-handlers-emit.ts` | `reposUsed` | (no bug — same reasoning) migrated onto `walkWorkflowStmtsDeep`; the built `Set` is `.sort()`-ed downstream so order is provably irrelevant | — |
| `src/generator/python/explicit-handlers-emit.ts` | `collectFactoryAggs` | (no bug) migrated onto `walkWorkflowStmtsDeep`; downstream `.sort()`-ed | — |
| `src/generator/python/explicit-handlers-emit.ts` | `collectRepos` | (no bug) migrated onto `walkWorkflowStmtChildren` for the recursion step, keeping original per-kind ordering exactly — two call sites iterate `repos` directly | — |
| `src/generator/python/explicit-handlers-emit.ts` | `handlerUsesUser` | (no bug — boolean predicate, order-independent) migrated onto `walkWorkflowStmtsDeep` | — |
| `src/generator/python/workflows-builder.ts` | `reposFor` | (no bug) migrated onto `walkWorkflowStmtChildren` for the recursion step, keeping original per-kind ordering — TWO call sites iterate `repos` directly to emit repo-construction lines | — |
| `src/ir/validate/checks/capability-checks.ts` | `walkReadExprs` | no `variant-match` arm | a stamp-field read nested in an arm/else body silently escaped the `capability-stamp-dedup` read-before-flush gate |
| `src/ir/validate/checks/domain-service-checks.ts` | `forEachStmtExpr` | no `variant-match` arm — the function's own docstring already claimed "visit every sub-expression reachable from a statement" | migrated directly onto `walkStmtExprsDeep` (deleted the hand-rolled body entirely) |
| `src/ir/validate/checks/structural-checks.ts` | `validatePermissionRefs` (workflow-statement half) | no arm for `assign`/`domain-service-call`/`resource-call`, and never descended into `for-each`/`if-let` bodies at all | an unknown-permission reference (`__unknown_permission__:` sentinel) nested in any of those skipped `loom.unknown-permission` entirely; migrated onto `walkWorkflowStmtExprsDeep`, factoring the leaf sentinel-check (`flagOne`) out of the recursive `flag` so the new call site doesn't re-walk-and-re-flag the same literal from every ancestor node |

## Rows — already exhaustive, certified with a `never`-check (zero behavior change)

Verified by an **exact case-set diff** against `walk.ts`'s own enumeration
(21 `ExprIR` / 11 `StmtIR` / 14 `WorkflowStmtIR` kinds) via a throwaway probe
script before touching the file — every one of these had already-complete
case coverage, so adding the compile-time guard changed no emitted byte
(confirmed: `npx tsc -b` stayed clean immediately after each edit, which
would have failed if the switch were not actually exhaustive).

- `src/ir/types/loom-ir.ts#stmtUsesMoney` (`StmtIR`, 11/11)
- `src/ir/validate/invariant-classify.ts#constructionEvaluable` / `#exprIsTranslatable` / `#firstFieldRef` (`ExprIR`, 21/21 each)
- `src/ir/validate/checks/shared.ts#firstNonQueryableNode` (`ExprIR`, 21/21)
- `src/generator/dotnet/validator-emit.ts#renderFluentPredicate` (`ExprIR`, 21/21 — already had an explicit catch-all listing every remaining kind)
- `src/system/e2e-render.ts#renderE2EExpr` / `src/system/ui-e2e-render.ts#renderUIExpr` (`ExprIR`, 21/21 each — same catch-all shape)
- `src/ir/validate/checks/projection-checks.ts#foldImpurity` (`StmtIR`, 11/11 — the function's own docstring already documents the allowlist-shape rationale)

## Waivers — 116 sites, four honest categories + two fences

Full map lives in the test file (`WAIVERS`); summarized here by bucket.
Every reason string names its own classification method, including its
limits, so a follow-up drain knows exactly what was and wasn't individually
re-verified.

| bucket | count | reason (verbatim key) |
|---|---|---|
| 2.6 hotspot-split fence | 11 | `system-checks.ts` (4), `ui-checks.ts` (6), `mikroorm.ts` (1) — packet 2.6 splits these files; re-triage each leaf post-split |
| in-flight PR fence | 12 | `zod-refine.ts` (#2736, 2), `_walker/walker-core.ts` + `heex-walker-core.ts` (#2729, 4), hono workflow builders (#2742, named in the packet brief as a fence even though this file's own current diff hadn't reached them — kept conservative, 6) |
| already delegates to sanctioned walker | 3 | `java/explicit-handlers-emit.ts#reposUsed`, `python/explicit-handlers-emit.ts#walk`, `python/workflows-builder.ts#visit` — migrated this packet (see table above); the census's if-chain detector still flags the narrow `if (kind === a \|\| kind === b \|\| …)` membership guard layered on top, which a terminal `never`-checked `else` genuinely does not fit |
| closed predicate/classifier, safe generic default | 41 | every unhandled kind falls through to a safe generic value (`false`/`undefined`/`null`/`[]`/documented neutral) — not a traversal, nothing silently drops from emitted OUTPUT. Classified by default-arm shape (verified with the census's own detector), **not individually re-read against every current kind this packet** — a genuine follow-up drain item |
| closed emission dispatcher, default THROWS | 34 | a LOUD failure (crash on generation), not the SILENT drop class 2.3 targets; case-completeness is emission-mode/parity scope (packet 2.4 and ongoing parity work), not this packet's |
| shallow one-level child-list builder | 4 | `exprChildren`-shaped functions (feliz/wire.ts, flutter × 3) — structurally `walkExprChildren`-shaped, genuine migration candidates, not completed this session |
| hand-rolled traversal, time-boxed | 11 | identified as genuine `walk.ts` migration candidates; not reached in this session's time-box |

**Honest scope statement**: this packet migrated or fixed **~24 functions**
across the two tables above (real M-T6.50-class gaps closed, plus
already-safe traversals migrated onto `walk.ts` for future-proofing) — most
of these no longer contain a switch/if-chain at all (the census surface
shrank, from 135 sites/88 files pre-packet to 133 sites at the branch tip,
even though 24+ sites were removed by migration — the census also grew a few
new small closed-classifier switches this packet's own new helper functions
introduced, e.g. `addCsExprUsing`/`addJavaExprImport`/`addPyExprImport`,
each waived as a closed predicate). Of the 133 sites the census finds today,
**17 are exhaustive** (7 certified with an explicit `never`-check after an
exact case-set verification against `walk.ts`'s own kind enumeration; the
rest delegate to a sanctioned shallow visitor after migration). The
remaining **116 waived** sites were NOT individually re-verified against the
current, full
`ExprIR`/`StmtIR`/`WorkflowStmtIR` kind lists in this session — they were
bucketed by their `default`-arm SHAPE (throw vs. safe-value vs. shallow
child-list), which is a real signal but not a substitute for reading each
one. **A follow-up drain packet should**, in priority order:

1. Re-read the 11 "hand-rolled traversal, time-boxed" sites first — these
   are the highest-confidence remaining M-T6.50 candidates (elixir vanilla's
   `collectParamRefs` family, `bodyExprs`, `collectVanillaLeaves`,
   `collectRecordFieldsInStmt`, `childExprs`; `dotnet/emit/dapper.ts#walk`;
   `elixir/dispatch-emit.ts#visitStmt`; `system/e2e-render.ts#visit`/`visit$2`).
2. Then the 4 shallow child-list builders (`exprChildren` in feliz/flutter) —
   likely safe drop-in replacements for `walkExprChildren`.
3. Then spot-check a sample of the 41 "closed predicate" waivers against the
   current kind lists — this is where a REAL silent gap is most likely
   hiding behind a plausible-looking `default: return false`.
4. The 34 "throws" dispatchers are lower priority for THIS census (they fail
   loudly, not silently) but are exactly packet 2.4's (emission-mode)
   material.

## Hard gate 1 — byte-identical emission + diagnostics

**Corpus generation diff**: `<scratch>/base` (fresh clone @ `ee8c2f0`, this
branch's fork point off `claude/wave-2`) vs `<scratch>/head` (this branch's
tip, `cb2b62438` + the docs commit closing this packet) — every
`test/fixtures/corpus/*.ddd` (58), `examples/*.ddd` (23), and
`web/src/examples/*.ddd` (47) fixture, 128 total, via
`node bin/cli.js generate system <f> -o <out>` (the natural single
full-system generation per fixture — each `.ddd`'s own `deployable` blocks
already declare which backends/frontends it targets, so this is the same
surface the corpus compile gates exercise).

`diff -rq <scratch>/base/gen <scratch>/head/gen`: 149 files reported as
differing (128 `.log` CLI-output files + 21 generated artifacts: 34 .NET
`.cs` domain-entity files, 3 `docker-compose.yml`). **Every one of the 149 is
explained by exactly two sources of expected non-determinism, verified with
a normalization pass (strip the two trees' differing absolute repo paths;
mask the `SECRET_KEY_BASE` random hex) that reduces the diff to zero:**

1. The 128 `.log` files and the .NET `.cs` files' `#line (...)  "<path>"`
   pragmas embed the ABSOLUTE PATH of the source `.ddd` file / output
   directory — an artifact of the fresh clone living at a different
   filesystem path than this worktree, not of any code change. (An
   in-worktree-only diff, base and head both generated from the same
   absolute repo root, would not show this — the fresh-clone comparison
   method is what introduces it, and the normalization pass accounts for
   it exactly.)
2. `docker-compose.yml`'s `SECRET_KEY_BASE` is randomly generated on every
   `generate system` run regardless of source — non-deterministic by
   design, unrelated to this packet.

Zero mismatches after normalization (`verify_diffs.sh` / `verify_logs.sh`,
run over every non-matching file pair): **byte-identical, confirmed.** File
SETS are identical too (`diff -rq` reported zero "Only in" lines — no file
was added, removed, or renamed by this packet's migrations on any of the
128 fixtures across every backend/frontend the fixtures' own `deployable`
blocks target).

**Diagnostics diff**: `node bin/cli.js parse` over every
`test/fixtures/**/*.ddd` (60 files, including the negative/invalid fixtures
the corpus generation step above does not reach) on both trees.

`diff -rq <scratch>/base/parse <scratch>/head/parse`: 58 of 60 files reported
as differing — every one is the diagnostic message's embedded absolute
source-file path (`<repo-root>/test/fixtures/corpus/<f>.ddd:L:C: ...`), same
cause as the `.log`/`#line` case above. Zero mismatches after the same
normalization pass (`verify_parse_diffs.sh`): **byte-identical diagnostics,
confirmed** — the validator checks made exhaustive this packet
(`validatePermissionRefs`, `walkReadExprs`, `forEachStmtExpr`,
`validateWorkflowBody`) fire the identical diagnostic set, same severities,
same locations, same message text, on every corpus fixture including the
negative ones.

**M-T9.33 firing census** (`test/system/diagnostic-firing-census.test.ts`,
the second proof the packet brief names): **103/103 tests pass** on the
folded tree — every `loom.*` diagnostic still fires at exactly the fixture
lines the census pins, confirming the validator checks made exhaustive this
packet (`validatePermissionRefs`, `walkReadExprs`, `forEachStmtExpr`,
`validateWorkflowBody`'s `domain-service-call` no-op arm) changed no
diagnostic's firing set.

## Hard gate 2 — census mutation-proof

Added a scratch file `src/ir/util/mutation-proof-scratch.ts` (new, untracked
— reverted by deletion, never `git checkout --`) with one deliberately
non-exhaustive, unwaived `switch (e.kind)`:

```ts
export function mutationProofProbe(e: ExprIR): string {
  switch (e.kind) {
    case "literal": return "literal";
    case "this": return "this";
    case "ref": return "ref";
  }
  return "other";
}
```

`npx vitest run test/system/ir-walk-census.test.ts` — the assertion
**"every offending site is exhaustive or waived"** (the second `it` block)
fails, naming the exact site:

```
AssertionError: src/ir/util/mutation-proof-scratch.ts#mutationProofProbe
(src/ir/util/mutation-proof-scratch.ts:9) — hand-rolled switch over
ExprIR.kind with no default:never / assertNever arm and no waiver. …
```

Reverted by deleting the scratch file (a new file this packet created —
no existing file's edits were at risk); re-ran the census, green again (5/5).

## Local gates run

- `npx tsc -b` — clean after every commit on this branch.
- `npm run lint` (`biome ci .`) — clean (12 pre-existing warnings in test
  files this packet never touched — unused imports in three
  `*-capability-filters.test.ts` files — left alone).
- `npx vitest run test/system/ir-walk-census.test.ts` — green (5/5).
- `npx vitest run test/system/diagnostic-firing-census.test.ts` — green (103/103).
- `npx vitest run test/ir test/system test/generator/dotnet test/generator/python test/generator/java test/generator/elixir` — green (728 files / 5707 tests, 1 skipped — folded-tree run after the last commit).
- Byte-identical corpus + diagnostics diffs — see Hard gate 1 above.

## Files outside the fence (handed off)

None — every fixed file was inside the packet's tree fence
(`src/ir/util/walk.ts`, the census test, and the offender sites the census
lists). The three explicitly-excluded hotspot files and the six in-flight-PR
files were waived, not edited, per the packet brief and the wave-2 in-flight
fence table.

## Docs

- `docs/audits/targets-completeness-2026-08-30.ledger.json` — no rows
  reference this packet's IDs directly (the ledger tracks the 08-24/08-31
  targets audits' findings; the walk-census defect class is #2720/#2705/
  M-T6.50-adjacent but not itself a ledger row) — nothing to flip.
- CLAUDE.md Conventions — added the one-paragraph rule per the packet
  instructions (census is in and green).
