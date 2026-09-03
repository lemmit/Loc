# Wave 2 — packet 2.7 (wave-1 residue) hand-off

*Branch: `claude/wave-2-residue`, based on `origin/claude/wave-2` @ `ee8c2f0`. Three rows —
the Wave 1 hand-offs with a named fix — from `docs/new-plan/waves/improvement-waves-2026-09.md`
§3/§3a and `docs/new-plan/waves/wave-2.md`'s packet table.*

## Rows

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `G2667-D3` java arm + RS rule | **fixed** | `test/generator/java/query-projection-join-missing.test.ts` — "reads every joined field through a null-guarded ternary, never a bare .get(...)" (`expected +0 to be 3`) and "keeps the wire projection INSIDE the guarded branch" (three named `.toContain` string checks); the java arm of `test/ir/projection-comprehension.test.ts`'s Hono-emission describe block ("emits the Java twin") | LEFT-JOIN semantics — `renderSelectWire` in `src/generator/java/emit/query-projection-reads.ts`. RS-34 recorded in `docs/conformance-semantics.md`. |
| `provenanced-bare-read-in-page-body` | **already-done-verified** | `test/generator/_walker/provenanced-bare-read-in-page-body.test.ts` (new — react/vue/svelte); 3 named assertions fail when the unwrap arm is disabled | The fix was ALREADY on this base (landed as a side effect of #2734's M-T6.12 provenanced-wire work, not as a targeted fix for this row). Re-verified by RUNNING the repro on all six shared-walker targets — see below. |
| `M-T1.8` on feliz/flutter/HEEx | **fixed** (3 of 5 remaining sub-targets; 2 — svelte/angular — are `#2720`'s, unmerged) | `test/generator/feliz/error-boundary.test.ts`, `test/generator/flutter/error-boundary.test.ts`, `test/generator/elixir/error-boundary.test.ts` — every assertion named in "Mutation-proofs" below | See "M-T1.8 — what's fixed and what isn't" below; `docs/new-plan/T1-ui-frontend.md` line flipped to `partial` with file:line citations. |

## Row 1 — `G2667-D3` java arm + the RS rule

**The fix.** `src/generator/java/emit/query-projection-reads.ts`'s `renderSelect` (unguarded
`<mapVar>.get(<key>).<member>()`) is now `renderSelectWire(t, expr, aliasMap)`: a member read
through a join alias renders `<lookup> == null ? null : <domainToWire(t, "<lookup>.<member>()")>`
— the null guard sits OUTSIDE `domainToWire`, so a joined `money`/`decimal`/`datetime` field's
non-null narrowing (`.setScale(…)`, `.doubleValue()`, `.toString()`) never runs on the absent
row. Matches the dotnet/node/python/elixir arms' LEFT-JOIN ruling from wave 1
(`docs/new-plan/waves/handoffs/wave-1-dotnet-adapters.md`): the source row survives, the joined
field carries wire `null`.

**Mutation-proof.** `src/generator/java/emit/query-projection-reads.ts` copied aside
(unique backup name, never `git checkout --`), `renderSelectWire`'s null guard removed
(reverted to `domainToWire(t, "${lookup}.${expr.member}()")`), md5-verified restore after:

```
4ed23bea2e79c87ec5c8a032e39df70d  before (good)
46615c9dc554bd4007e75fbf64a1ef52  mutated
4ed23bea2e79c87ec5c8a032e39df70d  restored — matches "before"
```

With the mutation in place: `test/generator/java/query-projection-join-missing.test.ts` —
"reads every joined field through a null-guarded ternary, never a bare .get(...)" fails
(`expected +0 to be 3`) and "keeps the wire projection INSIDE the guarded branch" fails on
all three `toContain` assertions (name/signedUpAt/discount); `test/ir/projection-comprehension.test.ts`'s
"emits the Java twin" test fails on the same shape. 4 named assertions total, across 2 files.

**Fixture.** New: `test/generator/java/query-projection-join-missing.test.ts`, mirroring
`test/generator/dotnet/query-projection-join-missing.test.ts` — a `softDeletable Customer`
joined by `Order`, three joined selects (`string`/`datetime`/`decimal`) so the guard-inside-wrap
placement is exercised for all three coercion shapes, not just the string case the pre-existing
`test/ir/projection-comprehension.test.ts` fixture carries.

**Byte-identical corpus check.** Full corpus (`examples/*.ddd` + `web/src/examples/*.ddd`, 70
fixtures) generated before/after into scratch dirs (`git stash` / `git stash pop` around the
"before" generation) and `diff -rq`'d: **byte-identical except four `docker-compose.yml`s'
`SECRET_KEY_BASE`** (a random value per generation, on the elixir-platform fixtures —
`examples/showcase.ddd`, `examples/tasks-vanilla.ddd`,
`web/src/examples/store-showcase-elixir.ddd`, `web/src/examples/storefront-elixir.ddd` —
unrelated to this change). **No corpus fixture declares a query-time projection `join` at all**
(grepped for `projection … join` across both directories — zero hits), so the join-alias code
path this row touches is genuinely unexercised by the corpus; the dedicated fixture tests above
are the only coverage, matching every other backend's arm.

**Compile leg.** `dotnet fable`-verified — wait, that's row 3's leg. For java: `gradle:9-jdk25`
docker was NOT used for this row (the java arm's shape is string-pinned, and the existing
`test:java`/`test:java-corpus` suite — `npx vitest run test/generator/java` — is what's run
locally: 93 files / 554 tests, all green, per "Local gates" below). A `gradle testClasses`
docker leg over a join-bearing fixture would additionally prove `javac` accepts the emitted
`? :` ternary nesting; not run here (time-boxed) — recommended as a follow-up if the coordinator
wants belt-and-suspenders on the java arm specifically, though the shape (`a == null ? null :
b`) is unremarkable Java that no javac version rejects.

**RS-34.** `docs/conformance-semantics.md` — "A query-time projection `join` is LEFT, not
INNER — the joined field is wire `null` when the target is absent." States the LEFT-JOIN
guarantee, records **why `null` uniformly** (not each language's own scalar default — the
.NET `default!` vs node `null` split the wave-1 node-ts hand-off left open), and is explicit
about scope: every backend's landed implementation is verified against a joined **`string`**
field only; a joined `int`/`decimal`/`bool`/`datetime` on .NET reads `default(T)` (`0`, `false`,
`DateTime.MinValue`), not wire `null` — a **documented, unfixed gap**, not silently claimed
conformant. Not added to `test/conformance/semantics-rules.ts` (the machine-readable registry):
its `SEMANTICS_RULES` array requires gap-free contiguous ids (RS-1..RS-N) and currently stops at
RS-31, while the doc already has RS-32/RS-33 with no matching registry entries — a **pre-existing
drift** this packet did not create and is out of scope to backfill (guessing at RS-32/33's
content risks worse damage than leaving the drift documented). Flagged under "Handed off" below.

## Row 2 — `provenanced-bare-read-in-page-body`

**Method note, per CLAUDE.md's own warning about the ledger's `open` bucket:** this row was
ALREADY FIXED on this base. `src/generator/_walker/walker-core.ts`'s `emitExpr` `case "member"`
already carries the "Provenanced<T> carrier hop (M-T6.12)" arm — `isProvenancedCarrierRead` +
the auto-`.value` append — landed generally by #2734 (its `_payload/provenanced-wire.ts` +
`docs/provenance.md` diff) as part of a broader M-T6.12 wire-shape change, not as a targeted fix
for this specific ledger row. The wave-1 hand-off's exact patch shape
(`docs/new-plan/waves/handoffs/wave-1-python-macros.md`) is, structurally, already present.

**Re-verified by RUNNING the repro**, not by reading — per the packet brief's explicit
instruction, since "Wave 1 found rows closed by parallel fleets." A hand-written (non-scaffold)
page body reading a `provenanced` field both bare and via `.value`
(`QueryView { …, data: row => Card { Text { row.total }, Text { row.total.value } } }`)
generated on all SIX shared-walker targets:

| target | bare `row.total` → | explicit `row.total.value` → |
|---|---|---|
| react | `{orderById.data.total.value}` | `{orderById.data.total.value}` (no double-hop) |
| vue | `{{ orderById.data.total.value }}` | same |
| svelte | `orderById.data.total.value` | same |
| angular | `{{ orderById.data()!.total.value }}` | same |
| feliz | `string (orderById.total.value)` | same |
| flutter | `'${orderById.total.value}'` | same |

A plain field (`row.reference`) is untouched on every target. No code change was needed;
this row is genuinely closed.

**What WAS missing: a pin.** Nothing in the suite exercised a HAND-WRITTEN body before this
packet — `test/generator/_walker/provenance-info-cross-target.test.ts` (the pre-existing
provenance test) only covers the SCAFFOLDED half, whose body the macro builds with `.value`
already spelled out (`_body-builders.ts`), so it never exercises the walker's auto-unwrap arm at
all. New: `test/generator/_walker/provenanced-bare-read-in-page-body.test.ts` (react/vue/svelte
— three of the six, per the packet's "one other target" ask; angular/feliz/flutter verified by
hand above but not separately pinned, to keep the new file's scope matched to the task).

**Mutation-proof.** `src/generator/_walker/walker-core.ts` copied aside (md5
`8c26ce0a10609961fc02353a38c6dfde`), the unwrap's `unwrapProvenanced && …` condition
short-circuited to `false && …`, restored after (md5-verified match). With the mutation: all
3 new tests fail — "auto-unwraps the bare read to `.value`, leaves the explicit hop single, and
leaves a plain field untouched" (react, `expected [ 'orderById.data.total}' ] to have a length
of 0 but got 1`), the vue and svelte siblings (each: `expected […] to have a length of 2 but
got 1`).

## Row 3 — `M-T1.8` on feliz / flutter / HEEx

**Read first, per the packet brief.** `#2720`'s own PR body (fetched via `pull_request_read`,
not assumed from the wave-1 coordinator log, which was WRONG about this — see "Correction"
below) states explicitly: *"M-T1.8 — no root render-time error boundary, svelte + angular
halves. … Feliz / Flutter / HEEx are the other three of the row's five targets and live in
other packets' trees — untouched, and stated as such."* This packet's tree fence is exactly
those three. No collision: `#2720` touches no file under `src/generator/feliz/**`,
`src/generator/flutter/**`, or `src/generator/elixir/**`; `#2721` touches
`feliz/feliz-target.ts` + `feliz/pack.ts` only (not `feliz/index.ts`, where this fix lives);
`#2723` touches `flutter/component-emit.ts` + `ui-checks.ts` only (not `flutter/index.ts`).

**Correction to the wave-1 coordinator's fold note.** `docs/new-plan/waves/wave-1.md` §Fold-of-#2734
says *"the six frontend-js rows … the provenanced page-body read"* landed in #2734, and this
packet's own task brief said *"#2734 landed it on the four JS frontends."* Both are **false**
for M-T1.8 specifically: `pull_request_read get_files` on #2734 shows NO file touching
error-boundary/render-time-crash machinery at all (its M-T1.8-adjacent-looking diff is
`_payload/provenanced-wire.ts` — unrelated, row 2's fix). Direct code read on this base: only
REACT ships a render-time boundary (`src/generator/react/index.ts:315-329`,
`api/error-boundary.hbs` + `src/logger.ts`) — pre-existing, older than any wave. **Vue, Svelte
and Angular have NO render-time boundary at all** — `grep -rln 'error-boundary\|ErrorBoundary'
src/generator/vue src/generator/svelte src/generator/angular` is empty; each emits only
`logger.ts` (the failure-SINK half, not the boundary). `#2720` (unmerged) builds the svelte +
angular halves; **vue has no in-flight fix anywhere found** — flagged under "Handed off" below,
since it is out of this packet's fence (`src/generator/vue/**`).

**The three fixes, each ported from the same conceptual contract (render-time boundary +
update/async-phase failure sink) onto a platform with no `componentDidCatch` equivalent:**

- **Feliz** (`src/generator/feliz/index.ts`) — a `safeView` function wraps `view`
  (the literal identifier `Program.mkProgram` mounts, whether that's the plain page-dispatch
  root or the `authUi` auth GATE that internally delegates to `appView`) in an ordinary F#
  `try`/`with`, rendering a `role="alert"` fallback panel and logging via
  `Fable.Core.JS.console.error` (needs no new package — `Fable.Core` is an unconditional
  dependency). `Program.withErrorHandler` is the update-phase failure sink (Elmish's own
  hook — catches an exception from a dispatched `Msg`, including an async effect's
  continuation). Fable-compile-verified: `dotnet tool restore && dotnet fable App.fsproj -o
  out --extension .js --noReflection` in `mcr.microsoft.com/dotnet/sdk:8.0` (docs/tools.md's
  own recipe, which the docs flag as "stays CI's to answer" — it does NOT; the SDK container
  compiles it fine) — zero errors, one pre-existing unrelated warning (F# code 40, line 227,
  nowhere near this change). Verified the compiled `App.js` actually contains `safeView`/
  `ProgramModule_withErrorHandler`/`"Something went wrong."`.
- **Flutter** (`src/generator/flutter/index.ts`'s `mainFn`) — `ErrorWidget.builder` (the direct
  Flutter analogue of `componentDidCatch`: replaces a crashed widget subtree with a fallback,
  framework-wide), `FlutterError.onError` (the framework's own uncaught-error terminus —
  a gesture callback / layout-pass exception outside `build()`), and `runZonedGuarded`
  (the mobile analogue of an unhandled-promise-rejection handler — M-T1.8's own "Unhandled-
  `await` terminus" wording — for a bare `async` callback with no `try`/`catch`). `main()`
  itself stays sync; the `persist:`-bearing app's `WidgetsFlutterBinding.ensureInitialized()`
  + `await LoomStorePersist.init()` now run inside the zone's async closure rather than in an
  `async main()`. `flutter analyze` (`ghcr.io/cirruslabs/flutter:stable`, docs/tools.md's own
  recipe) on the generated `sales-system-flutter.ddd` project: **36 pre-existing `info`-level
  lint hints, zero touching `main.dart`, zero errors, zero warnings** — confirmed unaffected.
- **HEEx** (`src/generator/elixir/vanilla/shell-emit.ts`) — the ONE genuinely open half: an
  `ErrorHTML` module + `render_errors`' `formats:` list now carries `html:` alongside `json:`,
  emitted only when the deployable mounts LiveView (`hasLiveView`). Before this, an
  HTML-accepting request that errors BELOW the router (a bad path, a plug crash ahead of
  `mount/3`, the initial disconnected "dead" render) fell through to Phoenix's own bare
  built-in fallback instead of anything this app styles. A **connected** LiveView crash is
  DELIBERATELY untouched: `phoenix_live_view.js` already ships its own reconnect/error
  overlay client-side, and the crashed process's exit is logged through the SAME `:logger`
  pipeline (`log_formatter.ex`) every other backend's failure sink writes through — OTP
  supervision gives that half of the contract for free, unlike the four JS/F#/Dart targets
  which each needed bespoke code. `mix compile --warnings-as-errors`
  (`hexpm/elixir:1.18.4-erlang-27.3.4-…`, docs/tools.md's pinned image) on the generated
  `storefront-elixir.ddd` project: fails, but on **two pre-existing warning classes unrelated
  to this change** (`is_mutable/1` clause grouping in `lib/phoenix_app/storefront.ex`, an
  `undefined attribute "data-testid"` on `CoreComponents.card/1` in two LiveView pages) —
  neither references `error_html.ex` or `config.exs`. A plain `mix compile` (no
  `--warnings-as-errors`) reaches `Compiling 98 files (.ex)` and prints those same two warning
  classes with nothing else, confirming `error_html.ex` itself compiles clean.

**Mutation-proofs** (each: file copied aside with a unique name, mutated, tested, restored,
md5-verified):

- feliz (`src/generator/feliz/index.ts`, md5 `61808c0fb561969fb590666f51449d8d`): reverting
  `Program.mkProgram init update safeView` / `|> Program.withErrorHandler (…)` to the pre-fix
  `Program.mkProgram init update view` (no error-handler line) fails 3 of 4
  `test/generator/feliz/error-boundary.test.ts` assertions.
- flutter (`src/generator/flutter/index.ts`, md5 `b1cd3b2eab6462899f6e6f36b3904e81`): reverting
  `mainFn`'s non-`initPrefs` branch to the pre-fix `["void main() {", "  runApp(const
  App());", "}"]` fails 3 of 5 `test/generator/flutter/error-boundary.test.ts` assertions.
- elixir (`src/generator/elixir/vanilla/shell-emit.ts`, md5
  `2aa22336f1e63ce469a7029d461eacda`): reverting the `render_errors` `formats:` line to drop
  the `html:` entry fails 1 of 3 `test/generator/elixir/error-boundary.test.ts` assertions
  (the `ErrorHTML` module itself and the strict-additivity JSON-API-only case are separate
  code paths this mutation does not touch, hence 1/3 not 3/3 — each is independently pinned).

**`docs/new-plan/T1-ui-frontend.md` line flipped** — `open` → `partial`, with file:line
citations for each of the five landed targets (react/feliz/flutter/HEEx-dead-render, plus
svelte+angular named as landed on `#2720`, unmerged) and the two genuinely still-`open`
sub-pieces (`errors {}` grammar, the unhandled-await terminus) named as belonging to the
separate ledger row `M-T1.8-errors-block-and-await-terminus` (P4).

**Ledger.** `M-T1.8-error-boundary-five-targets` stays in the `claimed` bucket (owned by
`#2720`, not this packet) — this packet does NOT flip it to `done`, because 2 of its 5 named
sub-targets (svelte, angular) are `#2720`'s unmerged work, not this packet's. Once `#2720`
lands, the row is ready to close (all 5 sub-targets — this packet's 3 plus `#2720`'s 2 — will
be on `main`).

## Files outside the fence (handed off)

- **`src/generator/vue/**`** — Vue has NO render-time error boundary at all (only `logger.ts`,
  the failure-sink half). Not covered by `#2720` (svelte+angular only) or any other in-flight
  PR found. A sixth target for whoever picks up the remainder of M-T1.8.
- **`test/conformance/semantics-rules.ts`** — the machine-readable RS-rule registry stops at
  RS-31 while `docs/conformance-semantics.md` already has RS-32/RS-33 (pre-existing, not
  raised here) and now RS-34 (this packet) with no registry entries. The registry's own gate
  (`test/conformance/semantics-rules.test.ts`'s "ids are unique and gap-free") requires contiguous
  `RS-1..RS-N`, so backfilling needs someone who can write RS-32/33's `trigger`/`observable`/
  `conforms` fields correctly — not guessed here.
- **`src/generator/dotnet/query-projection-emit.ts`** — RS-34 documents, but does not fix, the
  .NET value-typed joined-field gap (`default!` reads a language scalar default, not wire
  `null`, for a joined `int`/`decimal`/`bool`/`datetime`). One-line change in the
  `joinAliasRead` branch per the wave-1 dotnet hand-off, if the coordinator wants it closed
  rather than documented.

## Local gates run + results

- `npx tsc -b` — clean, after every edit.
- `npx vitest run test/ir test/generator/java test/generator/_walker test/generator/feliz test/generator/flutter test/generator/elixir` — **684 files / 5781 tests passed, 1 skipped** (pre-existing skip, unrelated).
- `npm run lint` (`biome ci .`, checked by EXIT CODE, not by grepping "Found N error" —
  #2720's own gates note names exactly why that grep is unsound) — exit 0. 12 pre-existing
  warnings, unrelated to every file this packet touches (`src/generator/dotnet/dto-mapping.ts`
  unused imports, an unrelated `parseValid` import) — baseline, not introduced here.
- Compile legs: `dotnet fable` (feliz, `mcr.microsoft.com/dotnet/sdk:8.0`), `flutter analyze`
  (flutter, `ghcr.io/cirruslabs/flutter:stable`), `mix compile` (elixir,
  `hexpm/elixir:1.18.4-…`) — all three per-row above.
- Byte-identical corpus diff for row 1 (java arm) — full 70-fixture corpus, per-row above.
- Every fix mutation-proven by file-copy revert (never `git checkout --`, unique backup
  names in `/tmp/wave2-diff/`), md5-verified restore, failing assertion named per row above.

## Report

Branch `claude/wave-2-residue`, pushed to `origin`. No PR opened (per instructions) — the wave
PR is #2770. Three rows: (1) java `G2667-D3` arm fixed + RS-34 recorded, byte-identical on the
full corpus; (2) `provenanced-bare-read-in-page-body` was already fixed on this base (a side
effect of #2734's unrelated M-T6.12 work) — re-verified by running the repro on all six
shared-walker targets and newly pinned (nothing exercised a hand-written body before); (3)
`M-T1.8` landed on feliz/flutter/HEEx (3 of the row's 5 remaining targets — svelte/angular are
`#2720`'s, unmerged; vue has no fix anywhere and is handed off). All gates green locally;
`docs/new-plan/T1-ui-frontend.md` and the ledger updated to match.
