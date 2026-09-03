# Wave 2 · packet 2.2 (escape-funnel) — hand-off

*Branch: `claude/wave-2-escape-funnel`. Base: `claude/wave-2` @ `ee8c2f0` (the
coordinator log commit). Tree fence: `src/generator/_expr/target.ts`,
`src/generator/_walker/target.ts`, the per-target leaf tables named in the
packet brief, the string-splice sites under `src/generator/elixir/**`,
`test/system/escape-funnel-census.test.ts`, per-target escape tests.*

## Row table

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `F2-ELX-ESCAPE-FUNNEL` class (P0, ledger `done` #2668) | **enforced** — the residual gap the ledger note itself named ("no enforcement beyond the four audited sites") is now closed | `test/system/escape-funnel-census.test.ts` → *"every generator JSON.stringify( site is a documented JS/safe-target position, a safe compiler-derived pattern, or an individually waived splice"* | see §Census below |
| seam declaration: `ExprTarget.escapeStringLiteral` | **added** — `_expr/target.ts`, all 5 backend targets | `npx tsc -b` (interface completeness — a missing implementation fails to typecheck); byte-identical corpus diff | delegates to the SAME function each backend already used (`JSON.stringify` for TS/C#/Java/Python, `elixirString` for Elixir) |
| seam declaration: `WalkerTarget.escapeAttr` | **added** — `_walker/target.ts`, all 6 frontend targets + HEEx | `test/generator/react/walker-target-contract.test.ts` → *"React/Vue/Svelte/Angular agree byte-for-byte (shared escapeHtmlAttr rule)"*, *"HEEx escapes the same four characters through its own live funnel"*; `test/generator/flutter/flutter-target.test.ts` → *"escapeAttr … is the same rule as escapeText"* | React/Vue/Svelte/Angular delegate to the existing shared `escapeHtmlAttr`; HEEx to the existing `escapeHeexAttr`; Feliz/Flutter alias `escapeText` (no separate attribute syntax) |
| `seed-emit.ts` `exStr` duplicate (Wave 1 hand-off finding) | **fixed** — deleted, replaced with the shared `elixirString` import | byte-identical corpus diff (0 diffs — same underlying function, same output) | |
| three Feliz sites bypassing `fsString` (`auth-gate.ts` gate literal, `realtime.ts` toast message, `wire.ts` form-field default) | **fixed** — routed through `fsString` | `npx vitest run test/generator/feliz` (372/372 green); byte-identical corpus diff (0 diffs — no fixture's literal hits a char where `fsString`/`JSON.stringify` diverge) | not a live injection (F# doesn't interpolate a plain `"…"` literal) — same "second copy of the escaping rule" shape the census exists to catch; kept as its own commit, separate from the pure seam extraction |
| census: `test/system/escape-funnel-census.test.ts` | **added** | mutation-proved, see §Census | classifies every `JSON.stringify(` under `src/generator/**` by destination |
| `G2667-A15-angular-apostrophe-crash` | already-done-verified (#2667) | `angularTarget.renderAttrBinding` escapes rather than throws (confirmed at cited lines) | ledger moved claimed → done |
| `G2667-D12-flutter-feliz-testid-escaping` | already-done-verified (#2667) | Flutter's `renderTimeline`/`testidKey` route through `dartString`/`escapeText` | ledger moved claimed → done |
| `G2667-C6-heex-testid-splice` | already-done-verified (#2667) | every `data-testid` site in `heex-primitives.ts` routes through `attrValue`/`escapeHeexAttr` | ledger moved claimed → done |
| `T6-backend-parity.md` `F2-MT640` row | **verified stale claim, nothing to fix** | `npx vitest run test/generator/elixir/heex-table-controls.test.ts` (10/10 green — *"a CLIENT-paged (non-serverPaged) list advertises no sort or pager"*) | the row the Wave 1 hand-off named (`T6-backend-parity.md:917`) no longer exists in that file — already removed in an earlier pass; the underlying fix (option b: drop sort/pager affordances on a non-paged list) is confirmed live on this base. Nothing left to flip. |

## Census — design and residual-review methodology

`src/generator/**` carries ~795 `JSON.stringify(` call sites. The census
classifies every one by DESTINATION, not by call shape (same discipline the
Wave 1 elixir hand-off used for its 173-site sweep):

1. **JS/TS-family** (typescript/, react/, vue/, svelte/, angular/,
   _frontend/, _obs/, _payload/, _channels/, _packs/, any `js-*.ts` leaf,
   `zod-refine.ts`, plus two files that emit real JSON despite living under
   `feliz/`/`flutter/` — `feliz/index.ts`'s package.json/tailwind config,
   `flutter/index.ts`'s web manifest) — auto-pass, `JSON.stringify` genuinely
   is the escape rule.
2. **C#/Java/Python** (dotnet/, java/, python/) — auto-pass with one
   recorded reason per directory: none of the three interpolates a plain
   double-quoted string literal.
3. **The danger bucket** — elixir/, feliz/, flutter/, and the `_walker`/
   `_expr` files reached by every target (not the `js-*.ts` JS-family-only
   leaves) — ~220 sites, every one reviewed by hand for this packet. All but
   six turned out to be compiler-controlled: a bare `ID`-terminal identifier
   chain (aggregate/field/event/workflow/param/capability names, route
   templates, dataset ids, env var names — none of which can carry `#{`/`$`/
   `"` per the grammar), a naming-normalizer call, a NUMBER-literal amount
   feeding `Decimal.new`, an internal LIKE-escape constant
   (`_expr/subtree-like.ts`, M-T3.17), or a call into a function this packet
   verified never returns raw author text (`messageCode` → a content hash,
   never the text; `problemTitle`/`disallowedMessage` → fixed strings off a
   closed status/name vocabulary; `fillHoles` → toolchain-fixed chrome text
   with only compiler-derived hole substitutions). The six genuine
   exceptions (i18n-emit.ts's JS-family-only `renderTranslate` fallback,
   `form-fields-vm.ts`'s fixed diagnostic string, two RFC7807 `title`s
   resolved through the same fixed status map, and two multi-line calls the
   single-line scanner can't parse — `denial.ts`'s `denialTitle(...)` and
   `flutter/index.ts`'s manifest object) carry individual,
   `${file}#${arg}`-keyed waivers with reasons, checked separately for
   `flutter/index.ts` by a dedicated `it`.

No NEW live injection was found in this review — Wave 1 (packet 1d) already
closed every genuine Elixir `#{` hazard, and Feliz/Flutter's own string
funnels (`fsString`, `dartString`) already handle their respective hazards
(F# doesn't interpolate; Dart's `$` is escaped) everywhere except the three
Feliz sites fixed above, none of which were exploitable. **Because of that,
gate 1's "hostile fixture" requirement doesn't apply here** — there is no
newly-fixed injection to demonstrate with one. The census's job in this
packet is enforcement (turning "a human reads ~800 call sites twice" into a
lint gate), not a fix.

## Mutation-proof

**Introducing a raw splice.** Appended a temporary function to
`src/generator/elixir/vanilla/denial.ts`:

```ts
export function __mutationProbe(message: string): string {
  return `"${JSON.stringify(message)}"`;
}
```

`npx vitest run test/system/escape-funnel-census.test.ts` fails
**"every generator JSON.stringify( site is a documented JS/safe-target
position, a safe compiler-derived pattern, or an individually waived
splice"** naming exactly
`src/generator/elixir/vanilla/denial.ts:476  JSON.stringify(message)`.
Reverted by file copy (`cp` aside first, restored after — never
`git checkout --`), md5-verified identical to the pre-mutation file
(`9b2dda99…`).

**Deleting/staling a waiver.** Renamed the `i18n-emit.ts` waiver's key from
`message` to `message-STALE-MUTATION-PROBE` (simulating its guarded call
site drifting out from under the waiver). The same assertion fails again,
this time naming `src/generator/_walker/i18n-emit.ts:91
JSON.stringify(message)` — proving the ratchet catches a stale/misaligned
waiver from either direction (a new unguarded site, or a waiver whose key no
longer matches a live site). Reverted by file copy, md5-verified identical
to the pre-mutation file (`f4ad4c19…`).

## Byte-identical gate

Corpus snapshot script (temporary, not committed — deleted before hand-off):
generates `generate system` output for every `test/fixtures/corpus/*.ddd`
fixture × the 5 `__PLATFORM__` substitutions (node/dotnet/java/python/
elixir, per `test/fixtures/corpus/backends.ts`), plus every `examples/*.ddd`
and `web/src/examples/*.ddd` file as-is, and hashes every emitted file.

- **Baseline** (pre-packet, `main`/`claude/wave-2` tip): 358/360 work items
  generate successfully (2 skips are pre-existing and expected: the one
  tracked `.ddd` design doc that can't parse, `examples/sales-ui.ddd`
  — `UNPARSEABLE_DDD` in `test/_helpers/ddd-corpus.ts` — and
  `projection-document-aggregation.ddd[java]`, an honest `loom.*` refusal,
  not a codegen bug); **24714 emitted files hashed**.
- **After the pure seam-extraction commit** (`d6103dd15` — the seven
  `escapeStringLiteral`/`escapeAttr` additions + `exStr` deletion):
  **0 diffs** against baseline, same 24714 files.
- **After the Feliz `fsString` fix commit** (`0f9d1bce9`, a real behavior
  change, kept separate per the packet's own instructions): **0 diffs**
  against the seam-extraction snapshot — no fixture's default/message/gate
  literal exercises a character where `fsString` and `JSON.stringify`
  actually disagree (both escape `"`/`\`/newline/tab identically; they
  diverge only on characters — `\r`, other control chars — none of the
  corpus fixtures use in a string default/message/gate literal).
- The `docker-compose.yml` `SECRET_KEY_BASE` field (`randomHex(64)`,
  `src/platform/elixir.ts`) is pre-existing per-run randomness, unrelated to
  this packet — normalized to a placeholder before hashing so it doesn't
  drown the diff in false positives; confirmed by generating the SAME
  fixture twice on an unmodified tree and diffing (only that one field
  differs).

No design-pack matrix rotation (the packet is a text-escaping refactor, not
a markup-shape change; each corpus/example fixture already carries its own
fixed `design:` pack, which is what actually generates).

## Local gates run + results

| gate | result |
|---|---|
| `npx tsc -b` | clean |
| `npm run lint` (`biome ci .`) | clean (exit 0; 12 pre-existing warnings in files this packet didn't touch) |
| `npx vitest run test/generator/elixir test/generator/_walker test/generator/feliz test/generator/flutter test/generator/angular test/system/escape-funnel-census.test.ts test/system/ledger-counts.test.ts test/system/gate-ledger.test.ts test/generator/react/walker-target-contract.test.ts test/generator/{dotnet,typescript,python,java}/render-expr-kinds.test.ts test/generator/elixir/phoenix-render-expr.test.ts` | green |
| `npx vitest run test/generator/elixir/elixir-string-escaping.test.ts` | green (10/10 — the Wave 1 mutation-proved suite, unaffected since Elixir's own escaping behavior is unchanged, only additionally declared on the seam) |
| elixir compile leg — `LOOM_ELIXIR_BUILD=1 LOOM_HEX_MIRROR=1 LOOM_CORPUS_ELIXIR_CASE=<case> npx vitest run test/e2e/corpus-elixir-build.test.ts`, cases `seeding` (touches the fixed `seed-emit.ts`) and `validation-messages` (touches `denial.ts`/`changeset-validators.ts`) | green — both compile clean under `mix compile --warnings-as-errors` |

## Files outside the fence

None. No hand-offs — every change landed inside the packet's declared tree
fence (`_expr/target.ts`, `_walker/target.ts`, the per-target leaf tables,
`elixir/**`, the census test, per-target escape tests, plus the ledger and
this hand-off note per the packet's own instructions).

## Ledger closes (ids)

`F2-ELX-ESCAPE-FUNNEL` — note extended (row was already `done` #2668;
residual-gap note now records this packet's `#2770` closing it).
`G2667-A15-angular-apostrophe-crash`, `G2667-D12-flutter-feliz-testid-escaping`,
`G2667-C6-heex-testid-splice` — moved `claimed` → `done`, citing #2667 (the
PR that actually fixed them; this packet only re-verified on fresh main
while reviewing the same escape-funnel class).

`node scripts/ledger-counts.mjs --write` run after every ledger edit;
`.md` header now reads `claimed by an open PR: 61` (was 64), `done/merged:
131` (was 128).

## Open questions for the coordinator

None. This packet found no design ambiguity — every seam addition delegates
to a rule its target already used, and the census's classification followed
the taxonomy the Wave 1 elixir hand-off had already established.
