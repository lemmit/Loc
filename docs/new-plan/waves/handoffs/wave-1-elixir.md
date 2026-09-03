# Wave 1 · packet 1d (elixir) — hand-off

*Branch: `claude/wave-1-elixir` (NOT `claude/wave-1/elixir` — git refuses a
`claude/wave-1/…` child while the branch `claude/wave-1` exists; the other
packets took the same flat spelling). Base: `claude/wave-1` @ `ca37863`.
Tree fence: `src/generator/elixir/**`, `test/generator/elixir/**`.*

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| `F2-ELX-ESCAPE-FUNNEL` (P0) | **fixed** (the four audited sites were already-done-verified; five MORE live splices found and closed) | `test/generator/elixir/elixir-string-escaping.test.ts` — 10 cases, each mutation-proved: reverting one site to `JSON.stringify` fails exactly its own case | see § below |
| `F2-W-01` | already-done-verified (#2668) | `test/generator/elixir/vo-jsonb-key-casing.test.ts` (green) | snake is the canonical stored VO sub-key (`__normalize_vo_keys/2`), with a camelCase compat read arm in `wire-serialize.ts:265-275` |
| `F2-FFE-6` | already-done-verified (#2668) | `test/generator/elixir/heex-string-concat.test.ts` (green) | `heex-walker-core.ts:1195-1205` now decides `<>` vs `+` off `leftType`/`rightType`/`resultType`, literal probe only as fallback |
| `M-T6.26-doc-put-presence` | already-done-verified (#2668) | `test/generator/elixir/document-update-presence.test.ts` (green) | `__require_keys/3` threaded into `document_changeset/3` (`document-emit.ts:329-357`) |
| `elixir-grapheme-vs-codepoint-length` | already-done-verified (#2668) | `test/generator/elixir/phoenix-render-expr.test.ts` + the emitted `validate_change` closures | both halves moved: `render-expr.ts:531-538` and `changeset-validators.ts` `lengthValidator` emit `length(String.to_charlist(value))`; verified in generated output (`product_changeset.ex:38`) |
| `F2-MT640-SORT-DEAD` | already-done-verified (#2668) | `test/generator/elixir/heex-table-controls.test.ts` → *"a CLIENT-paged (non-`serverPaged`) list advertises no sort or pager"* | option (b) taken honestly: `sort_field` is emitted only when the Table carries an active `sortKey:`/`sortDir:` pair (`heex-primitives.ts` `renderTableColumn`, `sortActive`) |
| `M-T6.2-s14-audit-wiresnapshot` | already-done-verified (#2646) | `test/generator/elixir/vanilla-audit.test.ts` → *"vanilla audit snapshot shape — Audit.Wire"*, and `audit_before = Api.Audit.Wire.wire(record)` | `audit-emit.ts` `renderAuditWireModule` routes every capture site (operation / create / destroy, relational and document) through `renderControllerSerialize` — the wireShape, unmasked |
| `G2667-C7-heex-button-icon-loading` | **fixed** (decision: render, not pin) | `test/generator/elixir/heex-button-icon-loading.test.ts` — restoring the drop fails 4 of 6 | see § below |
| `G2667-C8-heex-tab-slug-spaces` | already-done-verified (W1b #2704; ledger already `done`) | `test/generator/elixir/heex-tabs.test.ts` (green) | slug is `slugify(label)`, cross-target id equality pinned |
| `G2667-D6-elixir-seeder-not-atomic` | **fixed** (NOT closed by #2719 — re-verified open on this base) | `test/generator/elixir/seed-emit.test.ts` → *"commits each dataset's rows and its applied-marker in ONE transaction"* → `seed_default opens a transaction` | one `Repo.transaction/1` per dataset; rows + `mark_seeded/1` commit together |
| `G2667-D3-projection-join-unguarded-index` (elixir arm) | **fixed** (matching packet 1b's .NET LEFT-JOIN semantics) | `test/generator/elixir/query-projection-join-absent-target.test.ts` → *"reads the joined field through the total `__joined/2`, never off a bare Map.get"* | see § below |
| `F2-W-08` | **handed off** — wire-openapi | one VO component vs `<VO>Request`/`<VO>Response`; elixir is already on the majority convention, the change is on dotnet/java |
| `F2-W-09` | **handed off** — wire-openapi | `File` field inlines anonymously on node + elixir, names `FileRef` on the other three. The elixir half is in this fence (a `DWeb.Api.Schemas.FileRef` module + a `$ref` from `widget_response.ex`) but the row is one CONVENTION across five backends and the node half is packet 1c's fence — landing elixir alone swaps which two backends diverge. |

## `F2-ELX-ESCAPE-FUNNEL` — what was already done, and what was not

The four sites the ledger names (`schema-emit.ts` `renderEctoDefault`,
`denial.ts` `wireValidationTerm`, `changeset-invariant-emit.ts`,
`realtime-liveview.ts`) were **already routed through `elixirString`** on this
base, and `elixir-string-escaping.test.ts` already reached all four. Confirmed
by mutation: reverting each of the four to `JSON.stringify` fails exactly its
own assertion (all four fail together when all four are reverted).

The row's `faulty-fix` class turned out to be right about the *shape* though:
re-sweeping the emitter found **five more** author-written `.ddd` strings still
splicing raw into an Elixir string literal, each proven by generating before the
fix. In fix order:

| site | reached by | emitted, pre-fix |
|---|---|---|
| `changeset-validators.ts` `lengthValidator` | a **value object**'s messaged length invariant (a VO has no residual `add_error` carrier, so the author text rides Ecto's own validator — the one path the audited site 3 does not reach) | `[{:text, {"short #{:erlang.halt(1)} label", count: 3, …}}]` |
| `changeset-validators.ts` `ectoValidator` `message:` | the same, `validate_number` / `validate_format` | `validate_number(:weight, greater_than_or_equal_to: 0, message: "neg #{:erlang.halt(2)} weight")` |
| `heex-walker-core.ts` `elixirLiteral` | a page `state` string initialiser | `\|> assign(:note, "boot #{:erlang.halt(3)} end")` |
| `heex-walker-core.ts` guard flash | a page-handler `requires`/`precondition` — splices `stmt.source`, verbatim `.ddd` text | `put_flash(socket, :error, "Precondition failed: note != \"guard #{…}\"")` |
| `auth-emit.ts` `elixirAuthValue` / `envOrDeclared` | a declared (non-`env(...)`) OIDC `issuer:` / `clientId:` | `System.get_env("OIDC_ISSUER", "https://idp.example/#{:erlang.halt(7)}")` |
| `auth-emit.ts` claim path + `@scopes` | `claims: { role: "…" }`, `scopes:` | `get_claim(claims, "realm_access#{:erlang.halt(9)}.roles")` |
| `adapters/resource-clients.ts` ×4 | a `storage` config value: objectStore `bucket`, http `baseUrl`, mailer `from`, S3 `region` | `System.get_env("X_BUCKET") \|\| "b#{…}"` |
| `store-emit.ts` `renderStoreLiteral`, `tests-emit.ts` `renderLiteral` | same shape, funnelled alongside without a fixture of their own | — |

Gate is now 10 cases over four hostile fixtures (aggregate, value object, page,
auth). **Compile-verified**: the three hostile projects and the five touched
corpus fixtures build clean under `mix compile --warnings-as-errors` in the
`hexpm/elixir` image — so the escaped form (`\#{`) is valid Elixir, not just a
different string.

## `G2667-C7` — the decision

Rendered, not pinned. The drop existed because none of `icon:` / `iconSvg:` /
`iconPosition:` / `loading:` is an attr `<.button>` declares, and an undeclared
attribute on a Phoenix function component is a compile warning ⇒ a
`--warnings-as-errors` build failure. But **both** shipping HEEx packs'
`<.button>` already declare an `inner_block` slot and `attr :rest, :global`, and
that is enough — `designs/` is untouched:

- the glyph rides the CHILDREN slot as
  `<span class="loom-icon" aria-hidden="true">…svg…</span>`, before or after the
  label per `iconPosition:` (default `"right"`), resolved through the same
  `lookupBuiltinIcon` registry the JSX walker uses — the shape the shadcn /
  flowbite / shadcnSvelte templates emit;
- `loading:` becomes `aria-busy={…}` (`aria-` is one of Phoenix's global
  prefixes, so `:global` accepts it) and disables the button, OR-ed with an
  author `disabled:` so only one `disabled` attribute is emitted.

`PrimitiveSpec` grew `leadingChildren` / `trailingChildren` for this. Compile-
verified with a page carrying all five button shapes.

## `G2667-D3` — the elixir arm

`Map.get(customer_by_id, record.customer_id).name` raised
`UndefinedFunctionError` whenever the join target was soft-deleted or
capability-filtered out — a 500 from ordinary data. Now a total `__joined/2`
(LEFT-JOIN: source row survives, joined field nil), emitted only when the body
calls it (an unused private function is itself a `--warnings-as-errors`
failure). **RS rule to record**: a projection `join` whose target row is not
visible LEFT-JOINs on all five backends — worth a line in
`docs/conformance-semantics.md`, which is outside this fence.

## Files outside the fence (handed off)

- `docs/conformance-semantics.md` — the LEFT-JOIN RS rule for `G2667-D3` (above).
- `docs/new-plan/T6-backend-parity.md:917` — the `F2-MT640` row still reads
  `open` and still quotes the `list_orders/4` vs `list_orders/0` transcript,
  which no longer reproduces. Flip to `done` with the option-(b) rationale.
- `test/e2e/fixtures/elixir-vanilla-build/` — a hostile-`#{` pairing and the
  C7 button page would keep the compile tier reaching both; both were compiled
  here by hand, not pinned in a checked-in fixture.
- `docs/audits/targets-completeness-2026-08-30.ledger.json` — ledger closes below
  (not edited here, per the packet rules).
- Pre-existing, untouched: `src/generator/elixir/auth-emit.ts:277`
  `devClaimStringFields` is unused (biome `noUnusedVariables` **warning**, present
  on the base with my changes stashed). Left alone so the fold sees no unrelated
  diff; a one-line delete when someone is next in that file.

## Local gates run + results

| gate | result |
|---|---|
| `npx tsc -b` | clean |
| `npx vitest run test/generator/elixir test/system/generated-output-sentinels.test.ts` | **green — 189 files / 1200 tests**, on the final tree |
| elixir compile leg — `mix deps.get && mix compile --warnings-as-errors` in `hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim`, `LOOM_HEX_MIRROR=1` | **green** on: the 3 hostile-`#{` projects (aggregate / value object / page), the C7 button page (which also carries the hostile page-state, action-guard and VO literals), and corpus `projection-join`, `seeding`, `auth-oidc`, `validation-messages`, `core-domain`. No app-level Elixir warning in any of them (the only `warning:` lines are Loom's own missing-index IR warnings and one deprecation inside a hex dependency). |
| `LOOM_ELIXIR_BUILD=1 LOOM_HEX_MIRROR=1 LOOM_CORPUS_ELIXIR_CASE=validation-messages npx vitest run test/e2e/corpus-elixir-build.test.ts` | green |
| `npx biome ci <changed files>` | clean (except the pre-existing `auth-emit.ts:277` warning above) |

The compile-leg driver was a temporary `test/e2e/tmp-1d-elixir-compile.test.ts`,
deleted after the run — `test/e2e/**` is outside this packet's fence, so nothing
there is committed.

## Ledger closes (ids)

Fixed here: `F2-ELX-ESCAPE-FUNNEL` (P0), `G2667-C7-heex-button-icon-loading`,
`G2667-D6-elixir-seeder-not-atomic`, `G2667-D3-projection-join-unguarded-index`
(elixir arm — the .NET/node arms are packet 1b's).

Already-done-verified on this base (evidence in the table above), i.e. the
reconciliation can move them without re-checking: `F2-W-01`, `F2-FFE-6`,
`M-T6.26-doc-put-presence`, `elixir-grapheme-vs-codepoint-length`,
`F2-MT640-SORT-DEAD`, `M-T6.2-s14-audit-wiresnapshot`,
`G2667-C8-heex-tab-slug-spaces` (already `done`).

Still open, handed off: `F2-W-08`, `F2-W-09`.

## Wave 2.2 note — the remaining bare `JSON.stringify` splices, classified

All ~170 remaining `JSON.stringify` calls under `src/generator/elixir` were read
and classified **by what reaches them**, not by the call shape. Every one is
compiler-derived and cannot carry a `#{`:

1. **`ID`-terminal names** (the largest group — `f.name`, `p.name`, `e.name`,
   `wf.name`, `agg.name`, `sub.event`, `aux.aggName`, `variantTag`, `v.tag`,
   join aliases, `snake(...)` of any of them). Langium's `ID` is
   `[_a-zA-Z][\w_]*`: no `#`, `{`, `"` or `\` can appear.
2. **Strings the compiler BUILDS from those names** — route paths
   (`page-objects-emit.ts` urls, `shell-emit.ts` `live` routes,
   `sidebar-emit.ts`), `@schema_prefix` / `prefix:` schema names, join-table and
   `unique_constraint` names, env-var names, event-stream types, dataset names,
   `msg.<hash>` codes, `problemTitle(status)`, `Forbidden: find <name>`,
   `disallowedMessage(agg, op)`, kafka addresses / queues / groups.
3. **`NUMBER`-terminal literal text under `Decimal.new/1`** —
   `render-expr.ts:391`, `heex-walker-core.ts:737,2469`, `store-emit.ts:221`,
   `tests-emit.ts:399`, `schema-emit.ts:412`. Digits, `.` and `-` only.
4. **Emitted SQL / Ecto fragments the compiler renders** —
   `render-expr.ts:775` (`fragment(<sql>)` for the tenancy prefix intrinsic),
   `migrations-emit.ts:47,69` (a `fragment()` default is gated on
   `/^ident\(.*\)$/`; the partial-index `where:` is compiler-rendered SQL).
5. **One internal-only string** — `domain-service-emit.ts:436` builds `bodyText`
   purely to regex-test which params are referenced; it is never emitted.

Two structural follow-ups for Wave 2.2's "one escape funnel per target":

- **`seed-emit.ts:52` `exStr` is a DUPLICATE of `elixirString`** (same
  `JSON.stringify(...).replace(/#\{/g, "\\#{")` body, different name). It is
  correct today, but it is a second copy of the funnel and will drift. Delete it
  and import `elixirString`.
- **`elixirString` has no enforcement.** Nine live injection sites were found
  across two audits by reading call sites; a lint rule (or a `test/system` scan)
  banning `JSON.stringify` inside a template literal that is adjacent to a `"`
  in emitted-Elixir position would turn "someone re-reads 173 call sites" into a
  gate. Same argument applies per target — the .NET/Java/Python backends have
  no interpolating string literal, but the Elixir `~r/…/` sigil half
  (`elixirRegexBody`) is exactly as unenforced.

## Open questions for the coordinator

1. **Branch name.** `claude/wave-1/elixir` is unreachable while `claude/wave-1`
   exists as a branch (git ref hierarchy). This packet is on
   `claude/wave-1-elixir`, matching `claude/wave-1-node-ts` /
   `claude/wave-1-dotnet-adapters`.
2. **`G2667-D3` semantics across the five.** I matched packet 1b's LEFT-JOIN
   choice. If 1b instead chose "skip the row", say so and I will flip — but the
   two must not disagree, and the choice deserves an RS rule.
3. **`F2-W-09`'s elixir half** is a small, in-fence change, but landing it alone
   moves the divergence rather than removing it. Route the whole row to one
   owner.
