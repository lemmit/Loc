# Rename `platform: phoenix` → `platform: elixir`; `transport: phoenixRouter` → `transport: phoenix`

> Status: **SHIPPED** (#1043, R1–R6). `platform: elixir` is the
> canonical platform name (`Platform` in `src/ir/types/loom-ir.ts` is
> `"dotnet" | "node" | "react" | "static" | "elixir"`); the generator
> lives at `src/generator/elixir/`, the platform module at
> `src/platform/elixir.ts`. Back-compat aliases (`platform: phoenix`,
> `platform: phoenixLiveView`) keep existing `.ddd` sources working.
> D-ELIXIR-PLATFORM / D-PHOENIX-TRANSPORT / D-PHOENIX-DIR are pinned in
> [`decisions.md`](../../decisions.md). It landed before the vanilla emit
> subtree, which therefore lives at `src/generator/elixir/vanilla/` as
> planned. The design discussion below is retained for rationale.
>
> **(Superseded 2026: the Ash foundation was later removed. `platform: elixir`
> now generates Phoenix LiveView on PLAIN Ecto/Phoenix only; the `foundation:`
> knob remains but resolves to `vanilla` only — `foundation: ash` is now a
> validation error. This rename proposal predates that removal, so the
> `foundation: ash` examples and the ash-owned-axis prose below are historical;
> the platform/transport rename they document still stands.)**

## TL;DR

D-NODE-PLATFORM (PINNED) renamed `platform: node` → `platform: node` on
the principle that **platform names the language-ecosystem, transport
names the web framework**. The decision text justifies itself by
asserting *"`dotnet` / `phoenix` name the language-ecosystem"* and
*"`language` is `csharp` for `dotnet`, **`elixir` for `phoenix`**"* — a
rationalisation, not a fact. **Phoenix is a web framework**, not a
language ecosystem. The actual language ecosystem is **Elixir**.

This proposal completes the rename pattern:

```
platform: elixir              # the language-ecosystem (was: phoenix)
  foundation: vanilla         # knob retained; `vanilla` is the only valid value (ash removed 2026)
  transport: phoenix          # the web framework (was: phoenixRouter)
  framework: liveview         # on the ui — unchanged
```

`platform: phoenix` and `transport: phoenixRouter` become **back-compat
aliases** (identical mechanism to `hono` → `node` for D-NODE-PLATFORM)
that desugar at the lowering boundary. Existing `.ddd` sources work
unchanged.

Absorbs three sibling renames that were already debt from the
`phoenixLiveView` → `phoenix` rename (D-PHOENIX-SURFACE) but never
followed through past the platform name itself:

- Generator directory `src/generator/phoenix-live-view/` → `src/generator/elixir/`
- Platform module `src/platform/phoenix-live-view.ts` → `src/platform/elixir.ts`
- Design pack `designs/ashPhoenix/` → `designs/phoenix/` (foundation-aware internally)

Total surface: ~325 files reference `phoenix`/`Phoenix`; most are docs,
examples, and emitter strings; the IR / validator / registry plumbing
is a tight ~10 files. Mechanical with a back-compat alias; no
behavioural change.

## Why now

Three independently-strong reasons to do this before P2 of
[`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md):

1. **The repetition is structural, not cosmetic.** `platform: phoenix,
   transport: phoenixRouter` reads as "Phoenix Phoenix" — two
   restatements of the same framework. There's no
   "Phoenix-but-not-the-router" alternative; `phoenixRouter` carries
   no information beyond `phoenix`. Under `foundation: ash` the
   transport axis is *owned* (`FOUNDATION_OWNED_AXES.ash =
   ["application", "transport"]`), so it's never even settable by
   the user. The repetition is a code smell visible to every reader.

2. **P2 lands the vanilla emit subtree.** If P2 ships under the
   current name, we get `src/generator/phoenix-live-view/vanilla/` —
   a directory that reads as "vanilla under live-view", which is
   nonsense (vanilla doesn't necessarily emit LiveView; that's the
   `framework: liveview` axis on the `ui`). The rename done first
   means P2 lands at `src/generator/elixir/vanilla/`, which reads
   correctly.

3. **The four newly-PINNED decisions
   ([D-VANILLA-PHOENIX-FOUNDATION](../../decisions.md#d-vanilla-phoenix-foundation),
   [D-VANILLA-ES-HOME](../../decisions.md#d-vanilla-es-home),
   [D-NO-MIXED-FOUNDATION](../../decisions.md#d-no-mixed-foundation),
   [D-VANILLA-DEFAULT](../../decisions.md#d-vanilla-default))** all
   use the word "phoenix" with two different meanings — sometimes the
   platform (rename target), sometimes the LiveView-rendering web
   framework (stays). Doing the rename now surfaces the distinction
   in the text and prevents the ambiguity from compounding.

## Decisions to pin

| ID | Decision |
|---|---|
| **D-ELIXIR-PLATFORM** | `elixir` is the canonical language-ecosystem platform; legacy `platform: phoenix` is admitted as a back-compat alias that desugars to `platform: elixir { transport: phoenix }`. Mirrors D-NODE-PLATFORM's `hono` → `node`. |
| **D-PHOENIX-TRANSPORT** | The Phoenix framework is the `transport:` value on `platform: elixir`. Legacy `transport: phoenixRouter` is admitted as a back-compat alias that desugars to `transport: phoenix`. Future Elixir web frameworks (a Plug-only minimal API, hypothetical alternatives) slot into this axis as siblings. |
| **D-PHOENIX-DIR** | Generator directory `src/generator/phoenix-live-view/` → `src/generator/elixir/`; platform module `src/platform/phoenix-live-view.ts` → `src/platform/elixir.ts`; design pack `designs/ashPhoenix/` → `designs/phoenix/` (foundation-aware internally); CI workflow `phoenix-build.yml` → `elixir-ash-build.yml` (paired with future `elixir-vanilla-build.yml`). The rename is mechanical (sed + import-fix); back-compat aliases live at the validator/lowering boundary, not the directory level. |

## Why Phoenix-the-framework still keeps its name (D-NODE-PLATFORM symmetry)

D-NODE-PLATFORM kept `hono` as the canonical `transport:` value name — it
just demoted it from platform to transport. The same shape applies here:

| Concept | Today | After |
|---|---|---|
| Language ecosystem | `phoenix` (wrong — `phoenix` is a framework) | `elixir` ✓ |
| Web framework (transport) | `phoenixRouter` (redundant suffix) | `phoenix` ✓ |
| Server-rendered UI framework | `phoenixLiveView` (kept by D-PHOENIX-SURFACE) | `phoenixLiveView` (unchanged) |

Three different namespaces for "phoenix"-as-a-concept get cleanly
separated after the rename. Today they overlap.

## Surface — what every `.ddd` author sees

### Before

```
deployable api {
  platform: phoenix {
    foundation: ash,
    persistence: ashPostgres,
    transport: phoenixRouter,    # the user never writes this (Ash owns it under R4)
  },
  contexts: [Sales],
  port: 4000
}
```

### After

```
deployable api {
  platform: elixir {
    foundation: ash,
    persistence: ashPostgres,
    transport: phoenix,          # still rarely written (Ash still owns it)
  },
  contexts: [Sales],
  port: 4000
}
```

### Legacy sources keep working

```
# This still parses, validates, lowers, and emits — byte-identical:
deployable api { platform: phoenix, contexts: [Sales], port: 4000 }
# Desugars to: platform: elixir { transport: phoenix }
```

The two grammar tokens (`phoenix`, `phoenixRouter`) stay in the parser
as recognised aliases. The lowering boundary (`canonicalPlatform` in
`lower-platform.ts`) absorbs the desugar — same mechanism that handles
`phoenixLiveView` → `phoenix` today and `hono` → `node` after
D-NODE-PLATFORM ships.

## Surface — what changes inside the toolchain

### IR + grammar

| File | Change |
|---|---|
| `src/ir/types/loom-ir.ts:1923` (`Platform` union) | `"phoenix"` → `"elixir"` |
| `src/language/ddd.langium` (`Platform` rule) | Add `elixir`; keep `phoenix` as back-compat keyword |
| `src/ir/lower/lower-platform.ts` (`canonicalPlatform`) | Add `phoenix → elixir` alias; preserve `phoenixLiveView → elixir` chain |

### Platform registry + module

| File | Change |
|---|---|
| `src/platform/registry.ts` | `phoenix: phoenixPlatform` → `elixir: elixirPlatform`; alias map gains `phoenix: "elixir"` (mirrors `hono: "node"` line 160) |
| `src/platform/phoenix-live-view.ts` | Rename to `src/platform/elixir.ts`; export `elixirPlatform`; `name: "phoenix"` → `name: "elixir"` |
| `src/generator/phoenix-live-view/` | Rename to `src/generator/elixir/`; all internal imports update |
| `src/generator/phoenix-live-view/index.ts:83` (`generatePhoenixLiveViewProject`) | → `generateElixirProject`; sibling type `GeneratePhoenixLiveViewArgs` → `GenerateElixirArgs` |
| `src/generator/phoenix-live-view/adapters/` | Names stay (`ashPostgresPersistenceAdapter`, `ashStyleAdapter`, `byFeatureLayoutAdapter`); they're Ash-foundation-specific |

### Validator + menus

| File | Change |
|---|---|
| `src/language/validators/data/platform-rules.ts:184` | `family === "phoenix"` → `family === "elixir"` in the foundation menu |
| same file `:186` | `family === "phoenix" ? "phoenixRouter"` → `family === "elixir" ? "phoenix"` |
| same file `:119` | `if (fam === "phoenix") return "phoenixLiveView"` → `if (fam === "elixir") return "phoenixLiveView"` (default `framework:` for the language-ecosystem) |
| `FOUNDATION_OWNED_AXES` (line 226 region) | No change — ash still owns `["application", "transport"]` |

### CI workflows

| Today | After |
|---|---|
| `phoenix-build.yml` | `elixir-ash-build.yml` |
| `phoenix-dialyzer.yml` | `elixir-ash-dialyzer.yml` |
| `phoenix-obs-e2e.yml` | `elixir-ash-obs-e2e.yml` |
| (future, P5) `phoenix-vanilla-build.yml` | `elixir-vanilla-build.yml` |

### Design pack

| Today | After |
|---|---|
| `designs/ashPhoenix/` | `designs/phoenix/` |
| Templates use Ash-specific helpers throughout | Templates become foundation-aware (read `deployable.foundation` in the Handlebars helper); the form-binding partial branches on `ash` vs `vanilla` |
| `DesignPack` AST union (`generated/ast.ts:364`) | `'ashPhoenix' | …` → `'phoenix' | …` (back-compat: `ashPhoenix` parses as alias) |

The design pack rename is **deferred to P2** of the vanilla proposal,
since the foundation-aware template branching needs the vanilla emit
shape to exist. The `ashPhoenix` name stays in v1 of this rename
(decoupled and shippable).

### Tests

| Today | After |
|---|---|
| `test/generator/phoenix/*.test.ts` (already correct from P1) | No change |
| `test/generator/phoenix-live-view/*.test.ts` | None exist today — all phoenix-related tests already live under `test/generator/phoenix/` |
| Test fixtures referencing `platform: phoenix` in `.ddd` strings | Stay as-is — exercises the back-compat alias |
| One new positive test per axis change: parses + lowers `platform: elixir { transport: phoenix }` cleanly | Added |

### Documentation

Every doc that says "Phoenix platform" or "`platform: phoenix`" is
candidate for update. **Recommended: update authoritative docs
(`docs/platforms.md`, `docs/architecture.md`, `docs/generators.md`,
`CLAUDE.md`); leave historical audits / shipped proposals alone**
unless the wording is actively confusing. The four newly-PINNED
vanilla-phoenix decisions get a focused reword pass (see "Affected
decisions" below).

## Affected decisions — reword pass

These PINNED decisions have text mentioning "phoenix" in ways that
become ambiguous post-rename. Reword as part of this PR; semantics
unchanged.

| Decision | What gets reworded |
|---|---|
| [D-PHOENIX-SURFACE](../../decisions.md#d-phoenix-surface) | The decision survives — it's about *what the platform surface looks like*. The platform *name* in the text changes `phoenix` → `elixir`; the framework name (`phoenixLiveView`) stays. Title updated to **D-ELIXIR-SURFACE** (or kept with redirect note) — both work; recommend kept-with-redirect for paper-trail clarity. |
| [D-NODE-PLATFORM](../../decisions.md#d-node-platform) | Its self-justifying line *"`dotnet` / `phoenix` name the language-ecosystem"* (decisions.md:1072) is the rationalisation this proposal fixes. Update to *"`dotnet` / `elixir` name the language-ecosystem"* with a back-reference to D-ELIXIR-PLATFORM. |
| [D-VANILLA-PHOENIX-FOUNDATION](../../decisions.md#d-vanilla-phoenix-foundation) | Title → **D-VANILLA-ELIXIR-FOUNDATION**. Body reworded: "`foundation: vanilla` on `platform: elixir`" (instead of "on `platform: phoenix`"); rationale text untouched. |
| [D-VANILLA-ES-HOME](../../decisions.md#d-vanilla-es-home) | Body reworded: "pure event sourcing on Elixir lands only under `foundation: vanilla`"; the "Ash-foundation limitation, not a Phoenix-platform limitation" line stays (it's still accurate — the constraint is the Ash *foundation*, on the Elixir *platform*; the LiveView/Phoenix-framework dimension is orthogonal). |
| [D-NO-MIXED-FOUNDATION](../../decisions.md#d-no-mixed-foundation) | Body reworded — `platform: phoenix` → `platform: elixir` throughout. |
| [D-VANILLA-DEFAULT](../../decisions.md#d-vanilla-default) | Body reworded — the default flip is on `platform: elixir`. The `loom.foundation-default-flipping` warning name is unchanged. |
| [D-REALIZATION-AXES](../../decisions.md#d-realization-axes) | The table row showing the menu — `phoenix: ash · vanilla` → `elixir: ash · vanilla`. |

The Phoenix-related diagnostic codes in the validator
(`loom.foundation-vanilla-phoenix-not-yet-implemented`,
`loom.event-sourcing-not-supported-on-phoenix-ash`) **stay as-is** for
this rename — they're stable diagnostic identifiers users have already
seen, and renaming them costs more in user friction than the consistency
gains. Diagnostic *message text* gets the standard `phoenix` → `elixir`
sweep; codes are stable.

## Migration phases

| Phase | Scope | Approx. | Dependency |
|---|---|---|---|
| **R1** | Grammar + IR + lowering: add `platform: elixir` token + `transport: phoenix` value; back-compat aliases (`phoenix → elixir`, `phoenixRouter → phoenix`); regenerate Langium parser; commit the regenerated parser. Unit tests for the alias plumbing. | 1 day | — |
| **R2** | Registry + platform module rename: `src/platform/phoenix-live-view.ts` → `src/platform/elixir.ts`; `phoenixPlatform` export → `elixirPlatform`; registry key flip with alias map entry. Import updates across the toolchain. | 0.5 day | R1 |
| **R3** | Generator directory rename: `src/generator/phoenix-live-view/` → `src/generator/elixir/`; `generatePhoenixLiveViewProject` → `generateElixirProject`; sibling type rename. ~80 files of import updates. | 1 day | R2 |
| **R4** | CI workflow rename: `phoenix-*.yml` → `elixir-ash-*.yml`. Workflow-call sites in any composite actions. | 0.5 day | — |
| **R5** | Docs + decisions reword: `CLAUDE.md`, `docs/platforms.md`, `docs/architecture.md`, `docs/generators.md`; the seven affected decisions in `decisions.md`. Leave historical audits + shipped proposals alone (back-compat aliases keep their examples valid). | 1 day | R1 |
| **R6** | Examples + fixtures sweep: every `.ddd` with `platform: phoenix` either stays (exercises the alias) or migrates (proves the canonical form works). Keep a deliberate mix so the alias gets ongoing test coverage. | 0.5 day | R1 |

**Total: ~4–5 days focused.** Single coordinated PR — splitting it
would force temporary half-renamed states that fight import resolution.

The design pack rename (`ashPhoenix` → `phoenix`, foundation-aware
internally) is **deferred to P2** of
[`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md)
since it needs the vanilla emit shape to design the foundation
branching correctly.

## Back-compat guarantees

Every existing `.ddd` source continues to parse, validate, lower, and
emit byte-identical output. The alias plumbing lives at the lowering
boundary — same mechanism as `phoenixLiveView` → `phoenix` (D-PHOENIX-SURFACE)
and `hono` → `node` (D-NODE-PLATFORM).

| User wrote | Lowers to |
|---|---|
| `platform: phoenix` | `platform: elixir { transport: phoenix }` |
| `platform: phoenix { foundation: ash }` | `platform: elixir { foundation: ash, transport: phoenix }` |
| `platform: phoenix { transport: phoenixRouter }` | `platform: elixir { transport: phoenix }` |
| `platform: phoenixLiveView` | `platform: elixir { transport: phoenix }` (chained alias) |
| `platform: elixir` (new) | `platform: elixir { transport: phoenix }` |

No `loom.platform-deprecated` warning in v1 — the aliases are
permanent, not transitional. Mirrors how `hono` and `phoenixLiveView`
remain valid sources today.

## Risks (honest list)

1. **The generator directory rename touches many imports.** ~80 source
   files import from `phoenix-live-view/*`. Mechanical, but the IDE
   rename across the workspace is the safe path (TypeScript's path
   intelligence handles the rest). Risk: a few hand-cased strings in
   tests or docs that don't surface as import errors. The full fast
   suite + `LOOM_PHOENIX_BUILD=1` gate covers the behavioural side.

2. **Five PINNED decisions get reworded in one PR.** Risk of someone
   reading the decision log mid-PR and seeing inconsistent state.
   Mitigation: the rename PR is one focused commit; reviewer reads
   the diff in one sitting; back-compat aliases mean no `.ddd`
   source becomes invalid mid-transition.

3. **Diagnostic codes stay with `phoenix` in the name** (e.g.
   `loom.foundation-vanilla-phoenix-not-yet-implemented`). After
   rename, the message text says "Elixir foundation: vanilla is not
   yet implemented" but the code says `…phoenix…`. Slight discord.
   Recommend living with it — diagnostic codes are stable user-facing
   identifiers; renaming them is a separate decision with its own
   migration cost. The mismatch is small and survivable.

4. **The `ashPhoenix` design pack name stays in this PR.** It will
   look slightly odd post-rename (we have `platform: elixir` + `design:
   ashPhoenix`), but renaming it requires the foundation-aware
   template work that belongs to P2 of the vanilla proposal. Risk:
   another reviewer asks "why isn't this renamed too?" — answer it in
   the PR description.

5. **A `.ddd` source mixing `platform: phoenix` and explicit
   `transport: phoenixRouter`** is allowed by R1 (each alias resolves
   independently). After lowering, both desugar to `platform: elixir
   { transport: phoenix }`. No conflict, but slightly weird. Not a
   functional risk; just lives in the alias-handling logic.

## What this proposal explicitly does *not* do

- Rename `phoenixLiveView` (the UI framework token). It's the correct
  name for Phoenix's server-rendered UI framework — descriptive, not
  redundant.
- Rename the `ashPhoenix` design pack. Deferred to P2 of the vanilla
  proposal (needs foundation-aware template work).
- Add a `transport: plug` or `transport: cowboy` option. Stays size-1
  until a real second Elixir web framework lands.
- Change the Phoenix obs-e2e contract, the telemetry envelope, the
  ProblemDetails translator, or any wire shape. Pure naming-only.
- Rename diagnostic codes (e.g. `loom.foundation-vanilla-phoenix-not-yet-implemented`).
  See risk 3.
- Touch the dotnet platform or its `transport:` menu (already correctly
  named).

## Cross-references

- [D-NODE-PLATFORM](../../decisions.md#d-node-platform) — the rename
  pattern this completes. The decision text explicitly mirrors itself
  on D-PHOENIX-SURFACE; this proposal closes the loop.
- [D-PHOENIX-SURFACE](../../decisions.md#d-phoenix-surface) — the
  upstream half. Its conclusion (one `phoenix` platform, framework
  axis on `ui`) survives; the *name* `phoenix` migrates to `elixir`.
- [D-REALIZATION-AXES](../../decisions.md#d-realization-axes) — the
  axis vocabulary this rename leaves intact (only menu values change).
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) —
  the proposal whose P2 this unblocks. The vanilla emit subtree
  lands at `src/generator/elixir/vanilla/` instead of
  `src/generator/phoenix-live-view/vanilla/`.
- `src/platform/registry.ts:160` — the alias-map template this
  proposal copies (`hono: "node"` shape becomes `phoenix: "elixir"`).
- `src/ir/lower/lower-platform.ts:81` — the `canonicalPlatform`
  function that already absorbs `phoenixLiveView` → `phoenix` and
  `hono` → `node`; extends with `phoenix` → `elixir`.
