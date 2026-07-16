# Frontend feature-parity audit — 2026-07

> Status: **empirical pass — 2026-07-16.** Covers the **five** registered
> frontends — React, Vue, Svelte, Angular, and **Feliz (F#/Fable/Elmish)** — plus
> the Phoenix LiveView (HEEx) fullstack render path, and every shipped design pack.
> Refreshes and **supersedes** [`frontend-parity-audit-2026-06.md`](frontend-parity-audit-2026-06.md),
> which predates the Feliz frontend (registered since #1932/#1936) and so has no
> Feliz column at all.
>
> Read against `main` @ `9428b7e`. Every claim below was re-derived from the code
> on fresh `main`; the two silent-gap findings were **reproduced with the CLI**.
> **When this prose and the cited lines disagree, the code wins.**

This audit answers one question: **does the same `.ddd` page DSL produce an
equivalent app on every frontend target, or fail fast when it can't?** The
headline find is a **🔴 silent gap on Feliz** — 24 of the 44 pack-dispatched page
primitives have no Feliz renderer and emit a compile-clean placeholder comment
that silently drops the UI element, undetected by any gate.

## Method

Parity is enforced (or not) at four layers, audited in order (unchanged from the
2026-06 pass — see its §Method):

1. **Validator surface** — `src/language/walker-stdlib.ts` (the closed primitive
   library the validator accepts; a page that type-checks here is *legal against
   any target*). Pinned by `walker-stdlib-completeness.test.ts`.
2. **Walker-target contract** — `src/generator/_walker/target.ts` (`WalkerTarget`).
   The framework-shaped lowering seams a frontend implements to reuse the shared
   walker core (`walker-core.ts`, `walkBody`).
3. **Primitive dispatch table** — `src/generator/_walker/registry.ts`
   (`WALKER_PRIMITIVES`): 50 standalone + `Tab`/`Column`, each with a `tsx`
   renderer and *optionally* a `heex` one.
4. **Pack surface gate** — `src/generator/_packs/required-primitives.ts`
   (`REQUIRED_PRIMITIVES` per `PackFormat`) enforced at pack-load by
   `compilePack` (`loader.ts:346`). **This is the layer Feliz escapes** (see F1).

Since 2026-06 the roster grew a fifth frontend and the `WalkerTarget` contract
grew an **expression-syntax leaf seam** (`exprLiteral` / `exprBinary` / `exprUnary`
/ `exprTernary` / `exprConvert` / `exprList` / `exprObject`) — the frontend twin of
the backend `ExprTarget`. The JSX family shares one JS leaf table
(`js-expr-leaves.ts`); Feliz supplies F# leaves. These are **required**, so a new
frontend must decide its expression syntax up front (no JS fallback).

---

## 1. Frontend roster

| Frontend | `platform:` | Generator | Walker target | Design system | Render model |
|---|---|---|---|---|---|
| React | `react` (+ `static`) | `src/generator/react/` | `tsxTarget` | Handlebars packs (mantine/…) | Vite SPA, React Query |
| Vue | `vue` | `src/generator/vue/` | `vueTarget` | Handlebars packs (vuetify/…) | Vite SPA, vue-query |
| Svelte | `svelte` | `src/generator/svelte/` | `svelteTarget` | Handlebars packs (shadcnSvelte/…) | SvelteKit static SPA |
| Angular | `angular` | `src/generator/angular/` | `angularTarget` | Handlebars packs (angularMaterial/…) | Standalone Angular SPA |
| **Feliz** | **`feliz`** | **`src/generator/feliz/`** | **`felizTarget`** | **daisyUI theme (procedural pack)** | **Fable/F#/Elmish MVU SPA** (`dotnet fable` + vite) |
| Phoenix | `elixir` (LiveView) | `src/generator/elixir/` | `heexTarget` (parallel core) | Handlebars packs (coreComponents/daisyui) | Server-rendered HEEx |

**Feliz is architecturally the odd one out — and that is the root of F1.** The
four JSX/markup frontends *and* Phoenix consume Handlebars design packs validated
by the load-time `REQUIRED_PRIMITIVES` gate. Feliz "markup" is F# code
(`Html.div [ … ]`), so it ships a **procedural pack** (`src/generator/feliz/pack.ts`)
— a `LoadedPack` with an empty `templates` map and a hand-written `render(name)`
dispatch. It is constructed directly (`feliz/index.ts:229`), **never passes
through `compilePack`**, and there is **no `feliz` entry in `REQUIRED_PRIMITIVES`**.
A name its dispatch table lacks returns a visible comment instead of throwing:

```ts
render(name, context) {
  const fn = RENDERERS[name];
  if (!fn) return `(* feliz pack: no renderer for "${name}" *)`;   // pack.ts:330
  return fn(...);
}
```

---

## 2. Summary matrix

Rows are the parity concerns; cells are `✓` / `✗ gated` (honest fail-fast) / `🔴
silent` / `N/A`. The final column cites the authoritative gate + `file:line`.

| Concern | React | Vue | Svelte | Angular | Feliz | Gate (source of truth) |
|---|:--:|:--:|:--:|:--:|:--:|---|
| Required `WalkerTarget` seams | ✓ | ✓ | ✓ | ✓ | ✓ | `target.ts` (incl. expr-leaf seam) |
| Expression-syntax leaves | ✓ JS | ✓ JS | ✓ JS | ✓ JS | ✓ F# | `js-expr-leaves.ts` / feliz `FS_LEAVES` |
| Pack-dispatched primitives ship on target | ✓ (gate) | ✓ (gate) | ✓ (gate) | ✓ (gate) | **🔴 20/44** | `REQUIRED_PRIMITIVES` gate — **Feliz not gated**; `feliz/pack.ts` |
| Forms (Create/Op/Workflow/Destroy) | ✓ RHF | ✓ | ✓ | ✓ Reactive Forms | ✓ Elmish seams | Feliz `renderCreateForm`… `feliz-target.ts` |
| `store` UI primitive | ✓ Zustand | ✓ Pinia | ✓ runes | ✓ signals | ✓ Elmish Model | store gate lifted on all 5 — `store-checks.ts:301-304` |
| Async effects (`await` op in action) | ✓ | ✓ | ✓ | ✓ | ✓ | multi-variant unions + params + missing-`else` render; only routeless host / non-instance-op gated — `store-checks.ts:354` |
| `design:` axis | pack family | pack family | pack family | pack family | daisyUI **theme** | Rule 14 feliz branch, `deployable.ts:363`; `DAISYUI_THEMES` |
| Build CI gate | ✓ | ✓ | ✓ | ✓ | ✓ (curated) | `generated-feliz-build.yml` (inline showcase only) |
| Runtime-e2e CI gate | ✓ | ✓ | ✓ | ✓ | ✗ | no `generated-feliz-e2e.yml` |

---

## Findings

### F1 (HIGH, 🔴 SILENT) — Feliz drops 24 page primitives as compile-clean placeholders

**What.** Feliz's procedural pack (`feliz/pack.ts`) registers **20** of the **44**
pack-dispatched JSX-family primitives (`SHARED_PRIMITIVES` + `TSX_ONLY_PRIMITIVES`
in `required-primitives.ts`). The other **24** hit the `RENDERERS[name]` miss path
and emit `(* feliz pack: no renderer for "primitive-X" *)`. Because that is a valid
F# **block comment**, the emitted `Html.td [ prop.children [ (* … *) ] ]` becomes an
empty children list — it **compiles**, so `generated-feliz-build.yml` stays green,
and the element **silently vanishes** from the rendered UI.

The 24 with no Feliz renderer (code-verified — `RENDERERS` keys vs
`REQUIRED_PRIMITIVES.tsx.core`):

> `avatar`, `bold`, `code-block`, `container`, `date-display`, `enum-badge`,
> `field`, `form-of`¹, `grid`, `icon`, `image`, `inline-code`, `italic`, `loader`,
> `money`, `multiline-field`, `number-field`, `password-field`, `section`,
> `select-field`, `stat`, `sticky`, `tabs`, `toggle`

¹ `form-of` is in practice **seam-covered** — Feliz's `renderCreateForm`
(`feliz-target.ts:363`) returns non-null and builds inputs inline, so the shared
`emitCreateForm` never pack-dispatches `primitive-form-of` on Feliz. The other 23
are reachable whenever the primitive is used in a hand-written page (standalone
field/display primitives bypass the form seams).

**Reproduced** (fresh `main`, after `npm install` + `npm run build`):

```
# showcase.ddd Console UI retargeted to platform: feliz
$ node bin/cli.js generate system <showcase+feliz-Console>.ddd -o out
$ grep -rho 'no renderer for "[a-z-]*"' out/fe_cell | sort | uniq -c
   2 no renderer for "primitive-enum-badge"
   2 no renderer for "primitive-date-display"
   1 no renderer for "primitive-select-field"
   1 no renderer for "primitive-section"
   1 no renderer for "primitive-multiline-field"
   1 no renderer for "primitive-container"

# storybook-components.ddd ComponentCatalog retargeted to platform: feliz
   3 no renderer for "primitive-stat"
   1 no renderer for "primitive-toggle" / "primitive-tabs" / "primitive-grid" / "primitive-field"
```

11 distinct primitives silently dropped across two everyday examples. In the
`Projects` table the **Visibility** column (`EnumBadge`) and the **Created** column
(`DateDisplay`) both render as empty `<td>`s — a table with two blank columns and
no error anywhere in the pipeline.

**Why no gate catches it.**
- The load-time `REQUIRED_PRIMITIVES` gate (`loader.ts:346`) — which makes a
  *missing template* fail loudly at pack-load on Vue/Svelte/Angular — **does not
  run for Feliz** (procedural pack, no `feliz` format key). This is why the gap is
  Feliz-unique: the Handlebars frontends structurally cannot have it.
- `test/conformance/frontend-showcase-render.test.ts` renders the showcase across
  all five frontends, but its `FALLBACK_MARKERS` set is `["not supported",
  "unsupported expr", "unknown layout component"]` — it **does not include** `feliz
  pack: no renderer`. Proof: `npx vitest run … -t "feliz"` → **3 passed** (the
  `feliz:Console` cell asserts "renders cleanly" while emitting the 6 placeholders
  above).
- `generated-output-sentinels.test.ts` scans only the **5 backends** (`BACKENDS`),
  never the frontends, and its regex (`TODO|FIXME|unsupported|unimplemented`)
  wouldn't match `no renderer` anyway.

**Fix (a design call — the invariant to restore is "validates ⇒ generates, or
fails validation").**
- **Safe interim (loud, ~2 lines):** add `"feliz pack: no renderer"` to
  `FALLBACK_MARKERS` in `frontend-showcase-render.test.ts` so the showcase matrix
  fails on any Feliz placeholder, **and** either (a) add a `feliz` entry to
  `REQUIRED_PRIMITIVES` + route `felizPack()` through the load-time gate, or (b)
  make `pack.ts`'s miss path throw instead of returning a comment. Any of these
  converts the 🔴 into a loud failure without building renderers.
- **Principled fix:** implement the 23 reachable renderers in `feliz/pack.ts`
  (F#/daisyUI, mirroring the existing 20). Hand to `language-feature-developer`;
  the sibling to mirror is the same primitive's `tsx`/`heex` renderer in
  `WALKER_PRIMITIVES` plus the daisyUI HEEx pack (`designs/daisyui/`) for class
  parity.

### F2 (LOW) — no Feliz runtime-e2e gate; build gate uses a curated example only

`generated-feliz-build.yml` compiles a hand-picked inline `showcase.ddd` that, by
the workflow's own comment, "grows example-by-example as the procedural pack
does" — i.e. it is deliberately restricted to primitives Feliz supports, so it can
never surface F1. And unlike the other four frontends, Feliz has **no**
`generated-feliz-e2e.yml` (vite-preview + Playwright smoke) runtime gate. Not a
correctness bug on its own, but it means Feliz's rendered output is never exercised
end-to-end. Lower priority than F1; closing F1's gate hole is the higher-value move.

### Feliz feature status — implemented, and honest gaps where not

Two things that look like gaps are actually **implemented** on Feliz (do not gate
them — the store gate was already lifted):

- **`store` UI primitive → implemented.** Stores fold into the single-program
  Elmish `Model`/`Msg`/`update` — each store field becomes a namespaced `Model`
  field, each action a `Msg` case (`fs-expr.ts` `storeModelField`/`storeMsgCase`,
  `index.ts` `storeWrappers`, `feliz-target.ts:224` `renderStoreFieldRead` /
  `renderStoreActionCall`). `loom.feliz-store-unsupported` **no longer exists** as a
  live diagnostic — the comment at `store-checks.ts:301-304` records it was lifted
  when the subsystem landed. Store parity is uniform across all five frontends.
- **Async effects (`match await <op>()`) → implemented, incl. the harder shapes.**
  The Feliz MVU renderer covers the full shape on a `:id` detail page: a genuine
  multi-variant discriminated union (per-op outcome DU, one `update` arm per
  variant, named error arms reified from the non-2xx RFC-7807 `type` URI), an op
  with params (args threaded through the trigger Msg + Thoth-encoded into the POST
  body), and a missing `else` (no-op fallthrough). Fable-compile verified. Only two
  cases remain honestly gated (`loom.feliz-async-effect-unsupported`,
  `store-checks.ts:354`): a host with no route `id` (a component or non-`:id`
  page — an instance op has no id to POST to), and a subject that isn't an
  aggregate instance op. `classifyFelizAsyncEffect` (`util/feliz-async-effect.ts`)
  stays the shared arbiter so the gate and renderer can't drift.

Genuinely honest gap (parity invariant working as designed):

- **`design:` must be a daisyUI theme** → the validator (Rule 14 feliz branch,
  `deployable.ts:363`) rejects a component-library pack name on Feliz with the
  daisyUI theme list. Reproduced: `design: mantine` on a feliz deployable →
  `Design 'mantine' on Feliz deployable … is not a daisyUI theme.`

---

## 3. Status of the 2026-06 findings (all confirmed on fresh `main`)

| 2026-06 finding | 2026-07 status |
|---|---|
| F1 `Section`/`Sticky` crashed Vue/Angular codegen | **Still fixed** — both are in `TSX_ONLY_PRIMITIVES` (`required-primitives.ts:126`), enforced on the `tsx`/`svelte`/`vue` formats; `angular` filters `modal` but keeps `section`/`sticky`. The load-time gate now names a missing pack instead of crashing. |
| F2 pack breadth uneven | **Unchanged (LOW)** — React 4 families, Vue/Svelte 2, Angular 3 (`primeng`/`spartanNg` shipped). New: `daisyui@v1` HEEx pack shipped alongside `coreComponents`. |
| F3 no runtime-e2e for React/Angular | **Still fixed** for React/Vue/Svelte/Angular. New residual: **Feliz** has none (F2 above). |
| F4 stale "stubbed" Angular comments | Fixed. |

## 4. Design-pack roster (refreshed)

React `mantine`/`shadcn`/`mui`/`chakra`; Vue `vuetify`/`shadcnVue`; Svelte
`shadcnSvelte`/`flowbite`; Angular `angularMaterial`/`primeng`/`spartanNg`; Phoenix
HEEx `coreComponents`(default)/`daisyui`. **Feliz has no pack family** — its
`design:` slot selects one of the 32 `DAISYUI_THEMES` (`builtin-formats.ts:185`),
defaulting to `corporate` (light) / `business` (dark). `PackFormat` remains
`tsx | heex | svelte | vue | angular` — there is no `feliz` format, by design.

---

## Method notes

- **Roster** from `src/platform/registry.ts` (`platforms` map — `feliz` at :83) +
  `src/platform/metadata.ts` (`feliz` descriptor at :204, `hostableFrameworks:
  {feliz}`) + `Platform` union `loom-ir.ts:2766`. Read @ `9428b7e`.
- **F1 code side:** `feliz/pack.ts` `RENDERERS` (20 keys, :297-319) + miss path
  (:330); required surface from `REQUIRED_PRIMITIVES.tsx.core` (`SHARED_PRIMITIVES`
  39 + `TSX_ONLY_PRIMITIVES` 5 = 44). Set difference computed against the compiled
  `out/generator/_packs/required-primitives.js` → 24 missing.
- **F1 empirical side:** `bin/cli.js generate system` on (a) `examples/showcase.ddd`
  with a `platform: feliz` deployable bound to the `Console` UI, and (b)
  `web/src/examples/storybook-components.ddd` retargeted to `feliz`. Grepped emitted
  `fe_cell/**/*.fs` for `feliz pack: no renderer`.
- **Gate blind-spot proof:** `FALLBACK_MARKERS` (`frontend-showcase-render.test.ts:62`)
  lacks the feliz sentinel; `npx vitest run … -t "feliz"` → 3 passed while
  placeholders are present. `generated-output-sentinels.test.ts:57` iterates
  `BACKENDS` only.
- **Feliz feature status:** store gate lifted — no live `loom.feliz-store-unsupported`
  (`rg 'code:.*feliz-store-unsupported' src/` → 0 hits; comment at
  `store-checks.ts:301-304`); store emitters `fs-expr.ts`/`index.ts storeWrappers`/
  `feliz-target.ts:224`. Async v1 shape emits; unsupported slice gated at
  `store-checks.ts:354`. Design-theme gate `deployable.ts:363` — reproduced the
  `design: mantine` rejection via the CLI.
- **Root cause:** `loader.ts:346-363` (`compilePack` → `flattenRequired` gate) vs
  `feliz/index.ts:229` (`felizPack()` constructed outside it).
