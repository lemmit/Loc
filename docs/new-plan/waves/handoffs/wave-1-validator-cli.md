# Wave 1 — packet 1a (validator + cli) hand-off

*Branch: `claude/wave-1-validator-cli` (NOT `claude/wave-1/validator-cli` — git
cannot hold both `refs/heads/claude/wave-1` and a ref UNDER it; the leaf ref
already exists locally and on `origin`, so the assigned name is unrepresentable.
Coordinator: merge `claude/wave-1-validator-cli`.)*

## Headline

**Seven of the ten assigned rows were already fixed on this base — but row 1 had
residue in two more commands, now fixed.** Rows 1, 2, 4,
5 and 6 landed in **#2668** and **#2694**; row 3 (`F2-ADP-3`, the P0 handed to me
by W1b) was landed **by W1b itself** in #2708; rows 7 and 8 landed in the drain
that also carried #2699. The ledger's `open` array is stale for this packet
because #2668 *shipped the fixes in the same PR that produced the ledger* — the
JSON records the state the audit found, not the state that PR left behind.

Three rows were genuinely open: `F2-EXPR-5` and the `M-T3.8` diagnostic slice
are fixed here; `F2-CB-C9` is handed off, because its only clean fix is one file
outside the packet fence. A fourth piece of work came out of the "confirm the
already-done rows" pass the coordinator asked for: **`ir-warnings-invisible-in-cli`
had residue** — #2668 fixed two of the FOUR commands that run `validateLoomModel`,
and `snapshot` / `verify` kept the identical defect. Fixed here.

## Row table

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `ir-warnings-invisible-in-cli` (P1) | **already-done-verified** + **residue fixed** (`9eca96c`) | `test/cli/parse-ir-validation.test.ts` — "`ddd parse` prints every IR warning…" (`expect(out).toMatch(/^3 warning\(s\)\.$/m)`) and "`ddd generate system` prints IR warnings on the SUCCESS path". 6/6 pass on this base. | Fixed in **#2668** (`e0aff5a`). `runParse` prints every `severity === "warning"` diagnostic (`src/cli/main.ts:224-241`, `loom.index-suggestion` still footered separately); `runGenerate`'s warning print was hoisted out of the `loomErrors.length > 0` branch. Exit codes unchanged. **Other packets: warning-severity gates are visible on this base — no work needed.** **RESIDUE:** FOUR commands run `validateLoomModel`, and #2668 reached two. `runSnapshot` still held its print inside `if (loomErrors.length > 0)`, and `runVerify` filtered to `severity === "error"` AT THE CALL SITE — so its warnings never existed to print. Both now share one `printLoomWarnings`; the four-copies-of-three-lines shape is what let the fix reach half the sites. New pins: "`ddd snapshot` prints IR warnings on the SUCCESS path" (fails with `No written \`provenanced\` field found …` and no warning) and "`ddd verify` prints IR warnings instead of filtering them away" (fails with `Verified 2/2 requirements …` and no warning). Exit codes untouched on all four paths. |
| `F2-VAL-1` (P1) | **already-done-verified** | `test/language/validation/validator-never-throws.test.ts` — "keeps a context's other diagnostics when a `derived` initializer failed to parse": asserts no `/crashed and was skipped/` diagnostic AND that the sibling `/Default for 'label'/` error still surfaces. | Fixed in **#2668**. `checkDerived` guards `if (!d.expr) return;` (`src/language/validators/types.ts:753`) with the rationale in place. |
| `F2-ADP-3` gate (P0) | **already-done-verified** | **Ran the ledger's own repro on this base** — one `context Alpha`, one `resource alphaState`, `reader` (`dotnet { persistence: dapper }`) + `writer` (`dotnet { persistence: efcore }`): `ddd parse` now exits **1** with `loom.dapper-unsupported Split/reader: … Both deployables would start against DIFFERENT physical tables and each would see an empty database.` (was: `0 errors, 0 warnings`). Gate: `validateSelfProvisioningSchemaSupport` (`src/ir/validate/checks/migration-checks.ts:297`); messages at `src/diagnostics/messages.ts:1951`. | **W1b landed this itself** in **#2708**, contrary to the packet brief's "handed off by W1b". It refuses a context hosted by both a self-provisioning adapter (`dapper` / `mikroorm`, `SELF_PROVISIONING_ADAPTERS`) and a migration-chain one, and also refuses an explicit `schema:`/`tablePrefix:` on a lone self-provisioning deployable. I did not touch it. |
| `timer-tz-overlap-inert` (P1) | **already-done-verified** | **Ran it**: `timerSource sweep { … in: "America/New_York", overlap: allow }` now emits TWO `loom.reserved-not-emitted` warnings (`\`in: "America/New_York"\` parses and reaches the IR, but no emitter reads it …` and the `overlap: allow` twin). Pinned by `test/ir/reserved-not-emitted.test.ts` + its `RESERVED_SURFACES` completeness check; census fixture `"loom.reserved-not-emitted"`. | Fixed in **#2694**. `RESERVED_SURFACES` rows `timer-source-timezone` and `timer-source-overlap` in `src/ir/validate/checks/reserved-surfaces.ts`. |
| `eventlog-shape-silently-ignored` (P1) | **already-done-verified** | **Ran it**: `aggregate Account persistedAs: eventLog shape: document` is now an ERROR — `\`shape: document\` on event-sourced aggregate 'Account' is ignored — every backend's schema emitter short-circuits on \`persistedAs: eventLog\` before it reads \`shape:\` …`. Pinned by `test/language/validation/shape-on-event-sourced.test.ts`; census fixture `"loom.shape-on-event-sourced"`. | Fixed in **#2694**. Error gate at `src/language/validators/structural.ts:434`. |
| `M-T5.9-reserved-not-emitted` (P1) | **already-done-verified** | `test/ir/reserved-not-emitted.test.ts` (incl. the registry completeness pin — a row that stops firing must be deleted). | Fixed in **#2694**. The meta-diagnostic exists with its registry (`reserved-surfaces.ts`, 3 rows: timer tz, timer overlap, storage `connection:`). |
| `M-T6.18-gap3-criterion-arg-types` (P1) | **already-done-verified** | **Ran the ledger's own repro** on this base: `test/fixtures/corpus/criterion-filter.ddd` with `filter InRegion("EU")` → `filter InRegion(42)` now reports `Argument 1 of 'InRegion' expects 'string' but got 'int'.` (was: zero Loom diagnostics). | Landed in the same drain that carries the "GATES THAT NEVER REACHED THEIR SUBJECT" commit body naming `M-T6.18 gap 3`. |
| `M-T5.25` | **already-done-verified** | **Ran the mission's own repro**: `test/fixtures/corpus/projection-groupby.ddd` + `softDeletable` on `Order`, with `group by o.status ignoring softDeletable` → `error: 'ignoring softDeletable' sits in a position that DROPS it. A capability-filter bypass has three homes: …`. Gate: `src/language/validators/bypass-placement.ts`, `loom.ignoring-clause-placement`. | Fixed in **#2699**. A chain-borne `ignoring` is legal only as a `let` binding's own expression over a `.findAll(…)` / `.run(…)` read; `group by o.status ignoring softDeletable` is now an error rather than a silent drop. |
| `F2-CB-C10` | **already-done-verified** | **Ran the ledger's own repro** (`abstract aggregate Vehicle with tenantOwned` + `aggregate Car extends Vehicle with crudish`): the message is now `aggregate 'Car' declares no tenancy stance. Its abstract base 'Vehicle' declares \`with tenantOwned\`, but a stance does NOT propagate through \`extends\`: only the base's FIELDS are inherited … Repeat \`with tenantOwned\` on 'Car' — \`crossTenant\` would contradict th[e base]`. It names the real constraint AND warns off the remedy that used to walk into C11. Catalog key `loom.tenancy-stance-unmarked#inherited`. | Fixed in **#2701** (the TPH cluster). |
| **`F2-EXPR-5`** | **fixed** (`b5c4af4`) | `test/language/type-system/money-literal-promotion.test.ts` → "`price * 2` (money x int literal) validates" fails with the self-contradicting message; "the IR keeps the scalar literal scalar — money x int, not money x money" fails with `lit: "money"` where `lit: "int"` is expected. 5 of the 9 new cases fail under the mutation. | `money` no longer anchors literal promotion under `*` / `/` (it is closed under `+`/`-` and the comparisons only, per `moneyArithmetic`). Both mirrors moved together — `literalPromotionAnchor` in `src/language/validators/_shared.ts` and in `src/ir/lower/lower-expr.ts` — so no `money x money` node can reach a renderer. `long` / `decimal` anchor every operator as before; a TYPED `money * money` is still rejected. Emission verified by generating all five backends from one fixture (see the commit body for the six rendered expressions). |
| **`M-T3.8` diagnostic slice** | **fixed** (`27323db`) | `test/ir/sensitive-wire-unsupported.test.ts` → "warns on a sensitive field the wire actually serves" fails `expected +0 to be 1`; `test/system/diagnostic-firing-census.test.ts` → "loom.sensitive-wire-unsupported fires" fails "did not come out of its own fixture". 5 assertions fail under the mutation. | New `loom.sensitive-wire-unsupported` **warning** (`src/ir/validate/checks/sensitivity-checks.ts`). Says what `sensitive(...)` DOES buy (the synthesized `inspect` prints `<redacted>` on all five) and what it does not (the response DTO serves it in cleartext; no sink classification), and names the remedy that works today. Suppressed by `mask unless`, `internal` and `secret` — the three cases where the author already has the guarantee — so it marks real exposure only. `MAX_OPEN_GAPS` 46 → 47 with the reason written at the pin. **The masking itself was NOT built** (that is the T3 mission). |
| **`F2-CB-C9`** | **handed off** — clean fix is outside the fence | — | See §Hand-off below. Re-reproduced on this base. |

## Files outside the fence (handed off)

**`src/language/type-system.ts`** — for `F2-CB-C9`.

Re-reproduced on this base:

```
operation cancel() { requires Rules.isCancellable(this.qty) }
  -> error: 'requires' must be of type 'bool', got 'unknown'.

operation cancel() { requires Rules.isCancellable(this.qty) && true }
  -> 0 error(s), 0 warning(s).  OK
```

Root cause, confirmed by reading: `typeOfPostfixChain` (`src/language/type-system.ts:921`)
has a `<Repository>.<method>(...)` arm and an `<Aggregate>.create(...)` arm, and
NO `<DomainService>.<operation>(...)` arm — so the call types `unknown`, and the
statement-level gate at `src/language/validators/statements.ts:264` rejects
`unknown` (it does not carry the `unknown`-suppression its siblings do). The
`&& true` form passes because `typeOfExpr`'s `BinaryChain` arm returns `bool` for
any `&&` regardless of operands, and `checkSingleBinaryOperands` suppresses on an
`unknown` operand — two validators disagreeing about one expression.

The IR layer already resolves it correctly (`src/ir/lower/lower-expr.ts:2018-2035`,
`findDomainServiceByName` + `lowerType(opDecl.returnType)`), and the .NET emitter
now emits domain-service calls from a `requires` guard correctly (#2708's F2-CB-C7
fix). So the language ACCEPTS-and-EMITS this everywhere except the AST type gate.

**The fix is one arm, mirroring the repository arm directly above it.** Insert in
`typeOfPostfixChain` immediately before the final `curType = typeOf(expr.head, env)`
fall-through (currently `src/language/type-system.ts:975`):

```ts
  // `<DomainService>.<operation>(...)` — the AST twin of the arm
  // `lower-expr.ts` already has (`findDomainServiceByName` +
  // `lowerType(opDecl.returnType)`).  Without it the call types `unknown`,
  // and the `requires` / `precondition` gate rejects it as "got 'unknown'"
  // — while `<same call> && true` validates, because the binary arm returns
  // bool for any `&&` and suppresses on an unknown operand.
  if (isNameRef(expr.head) && first && isMemberSuffix(first) && first.call) {
    const svc = lookupDomainServiceByName(expr.head.name, env);
    const op = svc?.operations.find((o) => o.name === first.member);
    if (op?.returnType) {
      curType = resolveTypeRef(op.returnType);
      for (let i = 1; i < expr.suffixes.length; i++) {
        curType = typeAfterSuffix(curType, expr.suffixes[i]!, env);
      }
      return curType;
    }
  }
```

plus the lookup beside `lookupRepositoryByName` (`:1414`):

```ts
function lookupDomainServiceByName(name: string, env: Env): DomainService | undefined {
  const ctx = envContext(env);
  if (!ctx) return undefined;
  for (const m of ctx.members) if (isDomainService(m) && m.name === name) return m;
  return undefined;
}
```

(`isDomainService` and the `DomainService` type come from `./generated/ast.js`;
an operation with no declared `returnType` stays `unknown`, matching the
repository arm's fail-open posture.)

**Why I did not apply it in-fence.** The only in-fence alternative is to give the
seven `must be of type 'bool'` gates (`statements.ts:124/157/254/264`,
`structural.ts:288`, `repository.ts:37`, `types.ts:729/739/832`) the
`unknown`-suppression convention their sibling type gates use. That would remove
the contradiction, but it weakens seven gates to fix one missing type arm, and it
would be a private validator-layer workaround for a type-system hole — the
`G2667-D4` shape (a private copy of a derivation that disagrees with the shared
one). **Ruling question for the coordinator:** apply the one-arm patch above
(recommended — it makes the AST agree with the IR and with what the emitters
already do), or accept the suppression variant? No packet in this wave fences
`src/language/type-system.ts`, so the arm collides with nobody.

## Local gates run + results

- `npx tsc -b` — clean.
- `npx vitest run test/ir test/language test/cli test/system/diagnostic-catalog.test.ts test/system/diagnostic-firing-census.test.ts test/system/unsupported-register.test.ts` — see §Gate log below.
- `npx biome ci <11 changed files>` — clean (0 errors, 0 warnings).
- `node bin/cli.js generate system` on a money-arithmetic fixture × all five backends — all five emit correct scaling; no `money x money` node reaches a renderer.

## Ledger closes (ids)

Coordinator owns the ledger; these are the ids to move to `done`:

- `F2-EXPR-5` — fixed here (`b5c4af4`).
- `M-T3.8-sensitivity-phases-2-4` — **do NOT close.** Only the diagnostic slice
  shipped; the row stays open with its scope narrowed to phases 2-4 (the wire
  masking + sink classification). Note the new `loom.sensitive-wire-unsupported`
  register row, which the closing PR must delete.
- Already-done, verified here against code on this base (close if not already):
  `ir-warnings-invisible-in-cli`, `F2-VAL-1`, `F2-ADP-3`, `timer-tz-overlap-inert`,
  `eventlog-shape-silently-ignored`, `M-T5.9-reserved-not-emitted`,
  `M-T6.18-gap3-criterion-arg-types`, `F2-CB-C10-tph-stance-not-inherited`.
  `M-T5.25` (a mission, not a ledger row) is likewise done — its status line in
  `docs/new-plan/T5-language-core.md:161` still reads `open` and should flip.
- `F2-CB-C9-requires-unknown-message` — stays open, now carrying the exact patch
  above and a named fence reason.
- `ir-warnings-invisible-in-cli` — close it, but note the residue: the row named
  `runParse` and `runGenerate`; `runSnapshot` and `runVerify` had the same defect
  and were fixed here (`9eca96c`). A clean example of a row whose file-list was a
  SAMPLE, not a census.

## Open questions for the coordinator

1. **The `F2-CB-C9` ruling** (§Hand-off): apply the one-arm `type-system.ts`
   patch, or take the seven-gate `unknown`-suppression variant? Recommended: the
   arm.
2. **The ledger is stale for this packet, not wrong-by-drift.** #2668 both
   *produced* the ledger and *fixed* five of its rows; anyone reading `open` as a
   worklist will rebuild merged work, as I nearly did seven times. Worth a note in
   the ledger header — or better, a `verifiedAgainst` sha per row so `open` means
   "open at that sha" rather than "open".
3. **The branch name** — `claude/wave-1/<packet>` is unrepresentable in git while
   `claude/wave-1` exists as a leaf ref. Every packet hits this; the wave-1.md
   fold protocol should say `claude/wave-1-<packet>`.
4. **A ledger row's `fileTrees` is a sample, not a census.** `ir-warnings-invisible-in-cli`
   named `src/cli/main.ts` and, in its evidence, `runParse` + `runGenerate`. Two
   more commands in the same file had the identical defect, and the fix that
   closed the row left them. Worth asking every "fixed" row whether the *class*
   was drained or just the *cited sites* — the four-copies-of-three-lines shape
   that caused it here is common.
