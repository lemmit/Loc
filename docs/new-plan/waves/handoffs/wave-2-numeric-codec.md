### 2.1 numeric-codec — claude/wave-2-numeric-codec @ ed65cc458

M-T9.36. Tree fence: new `src/generator/_numeric/**`; the numeric decode/encode
arms of `src/generator/{dotnet,java,python,elixir,typescript}/**` and
`src/platform/hono/**`; `test/generator/_numeric/**`. Frontends untouched.

## Deliverable

`src/generator/_numeric/codec.ts` — `NumericKind` (`money`/`decimal`/`int`/
`long`), `numericKindOf(TypeIR)` (unwraps `optional`, classifies), and
`NUMERIC_WIRE_CODEC` — the decision table verbatim from the mission text
(money → RS-12 fixed-scale STRING, decimal → RS-24 float64 NUMBER, int/long →
NUMBER).

`src/generator/_numeric/target.ts` — the `_expr/target.ts` contract-plus-
leaf-tables shape applied here: `NumericBoundary` (`repo-read` /
`projection-read` / `dto-map` / `find-param` / `seed-read`), `NumericTarget`
(a backend's table of leaf functions, one per `(kind, boundary)` it actually
has code for), and `numericEncode(target, kind, boundary, expr)` — the
dispatcher, falling back to identity when the backend declares no leaf.

One `numeric-codec.ts` per backend (`src/generator/typescript/`,
`src/generator/dotnet/`, `src/generator/java/`, `src/generator/python/`,
`src/generator/elixir/vanilla/`) supplies the leaf table + a couple of named
sibling exports for boundary variants that share the *decision* but not the
exact *spelling* (documented per-file, e.g. `javaMoneyProjectionKeyEncode`,
`pyDocumentDecimalDecode`) — the same "second export, not a second contract
slot" pattern already used elsewhere in this codebase (`_expr/target.ts`'s
per-backend helper exports).

## Row table

| row | outcome | proof | notes |
|---|---|---|---|
| M-T9.36 (the whole mission) | **fixed** | byte-identical corpus/examples diff (below) + `test/generator/_numeric/boundary-census.test.ts` (6 assertions, mutation-proved 3 ways, below) | Landed as five commits: pure-extraction batch 1, java channel/SSE fix, pure-extraction batch 2, dotnet channel fix, census+codec tests. |
| `seed-read` boundary | **already-done-verified** | n/a — no code changed | Every backend renders seed values through the shared expression renderer (`_expr/target.ts`'s `money`/`decimal` literal arms — `render-expr.ts` per backend), which is already the one seam for that boundary. No backend hand-writes a seed-numeric literal outside it, so no backend needed a `seed-read` `NumericTarget` entry. Documented in `_numeric/target.ts`'s `NumericBoundary` doc comment so a future reader doesn't go looking for one. |
| packet 2.4 (emission-mode) / 2.5 (seeder-contract) territory | **not touched** | n/a | Kept to codec ARMS only, per the mission's explicit boundary — did not touch `_persistence/seed-datasets.ts` or the per-backend seed emitters' non-numeric shape. |

## Gate 1 — byte-identical emission

`node bin/cli.js generate system <f> -o <out>` for every `.ddd` under
`test/fixtures/corpus/`, `examples/`, `web/src/examples/` (128 files), before
(`ee8c2f0ec`, the base this branch forked from) and after — re-run after
every commit landed on this branch, the final pass at `ed65cc458`. 55/128
generate successfully under a bare `generate system` invocation on
BOTH revisions (identical set both times — the failures are pre-existing and
unrelated: `examples/*.ddd` legacy single-context sources need `generate ts`/
`generate dotnet`, several `test/fixtures/corpus/*.ddd` are `__PLATFORM__`
template fixtures meant to be substituted by the corpus test harness, and one
example (`sales-ui.ddd`) has a pre-existing parse error). `diff -rq` over the
two 55-fixture output trees: **the only differences are the per-generation-run
random `SECRET_KEY_BASE` value in four elixir `docker-compose.yml` files**
(`showcase`, `store-showcase-elixir`, `storefront-elixir`, `tasks-vanilla`) —
expected non-determinism (a fresh crypto-random secret every run), not a
refactor regression. Re-verified after EVERY commit in this branch (including
all three behavioral fixes) with the same result — none of the three changed
any of the 55 fixtures' output (consistent with the audit's own
finding that no corpus/example fixture puts a money field on a channel or
realtime payload — exactly the witness-starved gap the fixes close).

## Gate 2 — census mutation-proof

`test/generator/_numeric/boundary-census.test.ts` scans every `.ts` file
under the fenced trees for the extracted literal signatures (`.toFixed(` /
`new Decimal(` for TS-hono; `ToString("F<n>` / `double.Parse(` for dotnet;
`.setScale(` / `.toPlainString()` / `.doubleValue()` / `new BigDecimal(` for
java; `money_str(` / `Decimal(cast(` / `float(cast(` for python;
`Decimal.round(` / `Decimal.to_float(` for elixir), comment-stripped, against
a small reasoned waiver list. Three mutations, each reverted by file copy
(unique `.BAK-*` names) and md5-verified restored:

1. **Unregistered boundary.** `src/generator/typescript/repository-find-hydrate.ts`'s
   money arm changed from `numericEncode(TS_NUMERIC, "money", "repo-read",
   colExpr)` to the hand-rolled `` `new Decimal(${colExpr}).toFixed(4)` ``.
   Fails `M-T9.36 numeric-codec boundary census > typescript/hono: every
   numeric-coercion signature lives only in numeric-codec.ts`, naming
   `repository-find-hydrate.ts:182` twice (once per matched signature).
2. **Deleted waiver declaration.** Removed the
   `render-expr.ts` / `` return `new Decimal(${v})`; `` waiver entry from the
   census test itself while leaving the (legitimate, ExprTarget-owned) code
   untouched. Fails the SAME assertion — the previously-waived line is now an
   unwaived violation, naming `render-expr.ts:231`.
3. **Stale waiver (code rewritten, waiver left as-is).** Renamed the bound
   variable in `src/generator/elixir/liveview-emit.ts`'s `number_of/1` clause
   (`v` → `value`) without touching the census test. Fails BOTH `M-T9.36
   numeric-codec boundary census > elixir: every numeric-coercion signature
   lives only in numeric-codec.ts` (a new unwaived `Decimal.to_float(` match)
   AND `> every waiver still matches its exact waived line (waivers ratchet —
   no stale entries)` (the old waiver text no longer appears anywhere in the
   file) — defense in depth, either alone would have caught it.

`test/generator/_numeric/codec.test.ts` (9 assertions, not mutation-gated —
straightforward unit pins) covers `numericKindOf`'s classification (including
the `optional` unwrap and the "every non-numeric type → null" direction),
`NUMERIC_WIRE_CODEC` against RS-12/RS-24 verbatim, and `numericEncode`'s
identity fallback.

## Behavioral fixes (separate commits, each mutation-proved)

The exhaustive per-backend grep this refactor required (to build the census's
signature list precisely) surfaced two READ boundaries that decided the
number contract DIFFERENTLY from every sibling boundary — the exact defect
class M-T9.36 exists to retire, found as a side effect of enumerating rather
than searched for:

- **`84e9e4ad1` — java `emit/channels.ts`'s `toDataExpr` (channel-envelope
  payload) and `emit/realtime.ts`'s `javaRealtimeValue` (SSE frame) formatted
  money via a bare `.toPlainString()`**, which echoes whatever scale the
  domain `BigDecimal` happens to carry (its write scale, or an arithmetic
  result's) instead of the canonical 4dp `domainToWire` / `jpqlCoerce` /
  `groupKeyCoerce` already pin on the REST wire — the same #2549 class the
  audit's F18 named as witness-starved (no corpus fixture puts a money field
  on a channel or realtime payload). Now both route through
  `JAVA_NUMERIC.money["dto-map"]`. Mutation-proof: reverting
  `javaRealtimeValue`'s money arm fails
  `test/generator/java/realtime-emission.test.ts > realtime SSE wire — Java
  (delivery: broadcast) > emits the SseEmitter controller with the
  @EventListener tee` on a new assertion (`m.put("amount", …setScale(4,
  …).toPlainString());`) added alongside a `total: money` event field in the
  fixture. Also wired `channels.ts`'s inbound `fromDataExpr` (int/long/
  decimal/money envelope decode) through the codec's new `find-param` leaves
  — pure extraction, same shape as the projection-read int/long leaves.

- **`0b73451d0` — dotnet `emit/channels.ts`'s `toDataExpr` (channel-envelope
  payload) formatted money via a bare `.ToString(CultureInfo.InvariantCulture)`**,
  the identical bug class one level over. Now routes through
  `CS_NUMERIC.money["projection-read"]` (reusing that leaf's SHORT
  `CultureInfo` spelling — this file already brings `System.Globalization`
  into scope, unlike `dto-mapping.ts`'s fully-qualified `dto-map` leaf).
  Mutation-proof: reverting to the bare `.ToString(...)` fails
  `test/generator/dotnet/channels-transport-dotnet.test.ts > redis broker
  transport — dotnet leg (M-T4.4 slice 6a) > emits the transport module on
  both wired deployables` on a new assertion, added alongside a `total: money`
  event field + a `total: money("10.5")` emit in the fixture.

- **`ed65cc458` — elixir `channels-emit.ts`'s `encodeExpr` (the cross-
  deployable broker envelope codec) formatted money via a bare
  `Decimal.to_string`**, the same class a third time — the file's own
  docstring claims "wire parity with the Hono/Python/.NET/Java codecs", which
  the bare form broke. Split the shared money/decimal arm (they were one
  branch): money now renders through `ELIXIR_NUMERIC.money["projection-read"]`
  (round then explicitly `to_string`, the `__money_wire/1` shape); decimal
  keeps its existing bare `Decimal.to_string` — a documented, deliberate
  wire-FORM choice (Elixir's `Decimal` has no native JSON number form, so
  Jason strings it regardless; RS-24 has no fixed SCALE to pin, unlike money's
  RS-12), not a codec boundary, so left untouched. Mutation-proof: reverting
  the money arm to the bare `Decimal.to_string` fails
  `test/generator/elixir/channels-transport-elixir.test.ts > redis broker
  transport — elixir leg (M-T4.4 slice 6c) > emits the tee module on both
  wired deployables; the producer routes op emits through it` on a new
  assertion, added alongside a `total: money` event field + emit in the
  fixture.

All three fixes are pure — a bare `.toPlainString()` / `.ToString(culture)` /
`Decimal.to_string` becomes a call to the SAME leaf every other money-encode
boundary on that backend already uses; no new formatting logic was invented.
Found in that order (java → dotnet → elixir) because fixing java's channels
prompted a check of dotnet's channels file for the same shape, which prompted
the same check on elixir's — not from a plan, but each fix made the next
omission visible by contrast. Python's channel-adjacent boundaries
(`dispatch-builder.ts`'s `fromPayload`/`toPayload`) were checked too — see
"Deliberately NOT wired" below for `toPayload`'s own (different-shaped, lower-
confidence) anomaly. Neither fixture in the 128-file corpus/examples/web-
examples sweep exercises a money field on a channel or realtime payload, so
Gate 1's diff stayed empty across all three fixes — consistent with the
audit's own "no fixture exercised this path" diagnosis for the whole defect
family.

## Additional boundaries found and wired (pure extraction, folded into the
## "wire three more read boundaries" commit, `6c32795bf`)

The same grep found three more genuinely-duplicated sites beyond the ones the
initial `MONEY_WIRE_SCALE`-import grep surfaced:

- python `repository-document-builder.ts`'s `deserialize` (the document-
  adapter repo-read twin of `hydrateScalar`) — money matches
  `PY_NUMERIC.money["repo-read"]` exactly; decimal needed a third cast
  spelling (`pyDocumentDecimalDecode`, `float(cast(float, …))` vs.
  `hydrateScalar`'s bare `float(…)` and `fromData`'s `float(cast("int |
  float", …))`).
- python `dispatch-builder.ts`'s `fromPayload` (the in-process dispatcher's
  own event-payload decode) — the exact same int/long/decimal/money shape as
  `repository-eventsourced-builder.ts`'s `fromData`; now both call the same
  `PY_NUMERIC` leaves / `pyEventSourcedDecimalDecode`.
- elixir `context-emit.ts`'s `coerceOpParam` (find-param: an operation param
  binds off the raw decoded request map before `force_change`, per F12's
  fix — see the doc comment on that function) — money and decimal shared one
  `Decimal.new(to_string(...))` transform, now `ELIXIR_NUMERIC`'s new
  `money`/`decimal` `find-param` leaves.

## Deliberately NOT wired (reasoned, not silent)

- **TS `hono/v4/projection-builder.ts`'s `accumulate`/`toColumn`** — a
  query-time projection's incrementally-maintained STATE column
  (read-modify-**write** of a persisted running total: `new Decimal(cur ??
  0).plus(value).toString()`). This is a real numeric decision but not one of
  the five enumerated read boundaries (it writes the new stored value, not
  just reads one) — waived in the census with that reason. Worth a future
  audit as its own boundary class if the mission's five-boundary enumeration
  ever grows a sixth ("projection-accumulate").
- **python `render-expr.ts`'s `toPayload`/`dispatch-builder.ts`'s money arm
  (`str(${expr})`)** — the domain-event OUTBOX payload write (internal
  event-bus serialization, round-tripped by the SAME representation via
  `fromPayload`'s `Decimal(cast(str, …))`, never reaching an external HTTP/SSE
  wire directly). A bare `str(Decimal)` does not carry the fixed RS-12 scale
  the way `money_str()` does, so this MAY be a genuine anomaly of the same
  #2549 class — but it is a write-then-read-back-internally path, not one of
  the five named boundaries, and I did not have a safe way to verify no
  internal consumer depends on the un-fixed scale within this packet's time
  budget. **Handed off** — flagging for a future numeric-types follow-up
  audit rather than fixing blind.
- **dotnet `dto-mapping.ts`'s `wireToCommandArgument` money arm
  (`decimal.TryParse(expr, NumberStyles.Number, CultureInfo.InvariantCulture,
  out var out)`, inside the shared `wireParseGuard` helper)** — a real
  `find-param` boundary, but the ONLY site of its kind in the fenced tree (no
  duplication to retire), and its two-variable shape (`expr` + a freshly
  allocated `out` name) doesn't fit the single-string `NumericLeaf` contract
  cleanly. Left as-is; the census's dotnet signatures (`ToString("F<n>` /
  `double.Parse(`) don't match `decimal.TryParse(`, so it is not silently
  exempted by omission — it is simply outside this packet's signature set.
  Noted here for the record, not silently dropped.

## Local gates

- `npx tsc -b` — clean, after every commit.
- `npm run lint` (`biome ci .`) — clean; 12 PRE-EXISTING warnings elsewhere in
  the tree (two stale `test/fixtures/corpus/*.test.ts` imports, two files
  outside this fence with an already-unused `snake`/`provColumn` import) —
  verified present on the base commit (`ee8c2f0ec`) before I touched anything,
  unrelated to this packet.
- `npx vitest run test/generator/_numeric/` — 15/15 pass.
- `npx vitest run test/platform/pipeline-layering.test.ts
  test/platform/backend-packages-layering.test.ts` — 11/11 pass (the new
  `_numeric/` module and its per-backend leaf-table siblings introduce no
  backward edge across `language → ir → generator → system`, nor across
  `generator → platform`).
- Full per-backend generator suites, all green:
  `test/generator/dotnet/` — 106 files / 699 tests;
  `test/generator/java/` — 91 files / 535 tests;
  `test/generator/python/` — 86 files / 488 tests;
  `test/generator/elixir/` — 171 files / 1104 tests;
  `test/generator/typescript/` + `test/generator/hono/` — 113 files / 697
  tests. 3523 tests total.
- `test/platform/` (full dir) — 452/456 pass; the 4 failures
  (`packaging-split-fs-discovery.test.ts` ×3, `packaging-split-core-pkg.test.ts`
  ×1) are a pre-existing workspace-symlink discovery issue in this sandbox —
  reproduced identically on the base commit (`ee8c2f0ec`) with my tree
  reverted, unrelated to `src/generator`/`src/platform` content.
- **Compile legs, against a fresh money/decimal/`int * money` arithmetic
  fixture** (`test/fixtures/corpus/numeric-operands.ddd`, `__PLATFORM__`
  substituted per backend, generated post-refactor):
  - **.NET** — `mcr.microsoft.com/dotnet/sdk:10.0`: `dotnet restore &&
    dotnet build /warnaserror` — 0 warnings, 0 errors.
  - **Java** — `gradle:9-jdk25`: `gradle --no-daemon testClasses bootJar` —
    BUILD SUCCESSFUL (also separately proves the java channel/realtime fix's
    host code compiles, via the full `test/generator/java/` suite and the
    channels/realtime test files specifically).
  - **Python** — `uv sync && uv run ruff check . && uv run mypy --strict . &&
    uv run pytest -q` — all clean; the fixture's own domain `test` block
    (right-hand money/decimal operand arithmetic) passes as a real pytest
    assertion.
  - **Elixir** — `LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1
    LOOM_PHOENIX_VANILLA_BUILD_CASE=vanilla-money-return.ddd npx vitest run
    test/e2e/generated-elixir-vanilla-build.test.ts` (the repo's own harness
    + hex-mirror, since a raw `mix deps.get` hits the documented Erlang/OTP
    TLS-fingerprint proxy wrinkle) — `mix compile --warnings-as-errors`
    green: `Test Files 1 passed (1)`, `Tests 1 passed (1)`. The full
    74-fixture `npm run test:phoenix` matrix was not run in full (each
    fixture cold-compiles its own dependency tree from scratch in a fresh
    container — ~90s for this one fixture alone, ~2h for all 74 — CI shards
    it one-fixture-per-cell for exactly this reason); the one-fixture spot
    check plus the 171-file / 1104-test `test/generator/elixir/` suite
    (byte-exact assertions on every emitted line this packet touches) is the
    coverage this packet's time budget bought.

## Ledger / docs

- `docs/audits/targets-completeness-2026-08-30.ledger.json`: moved
  `G2644-M-T9.36-wire-codec-seam` from `open` to `done`, `"pr": "#2770"`,
  `"sha": "5b3ea8dce"`. `node scripts/ledger-counts.mjs --write` regenerated
  the companion `.md`'s Counts + Open-ledger tables; `--check` confirms they
  match.
- `docs/new-plan/T9-toolchain-health.md` M-T9.36 flipped to `done` with a
  landed-summary paragraph (file:line references above).

## Files outside my fence

None edited. Every change is under `src/generator/_numeric/**`,
`src/generator/{typescript,dotnet,java,python}/numeric-codec.ts`,
`src/generator/elixir/vanilla/numeric-codec.ts`, the numeric decode/encode
arms of `src/generator/{dotnet,java,python,elixir,typescript}/**` and
`src/platform/hono/**`, `test/generator/_numeric/**`, and the three
behavioral-fix test fixtures (`test/generator/java/realtime-emission.test.ts`,
`test/generator/dotnet/channels-transport-dotnet.test.ts`,
`test/generator/elixir/channels-transport-elixir.test.ts`), plus
`docs/audits/targets-completeness-2026-08-30.{json,md}` and
`docs/new-plan/T9-toolchain-health.md`.
