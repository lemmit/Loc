# T1 — UI & frontend ceiling

*The product's #1 weak spot ([weak-spot review](../audits/architecture-weak-spots-2026-07.md) §1): the scaffolded UI is excellent until the closed primitive set runs out, then customization is an all-or-nothing ejection. These missions raise the ceiling and soften the cliff.*

## M-T1.1 — Paged, sorted, filtered Table — `partial` · **L** · P1
The wire ships the `paged` carrier; no frontend consumes it. `Table`/`QueryView` fetch entire collections; no column sort, no interactive filter. Add pagination/sort/filter to the `Table` primitive across the four JSX walkers + HEEx and the pack templates (server-driven via `paged` + query params where the source supports it, client-side fallback otherwise).
**Decisions (design pass 2026-07-13, maintainer-signed):** (A) route interactive state through page-level `state {}` + the existing `renderStateWrite` seam — no new primitive-local-state seam (invariant #7); (B) **client-side v1** (sort/filter/slice the bound array); server-driven `QueryView`-unwrap is a decoupled slice 2 that auto-upgrades once M-T2.6 flips the scaffold's unbounded `.all` to paged; (C) the 4 JSX targets land together, HEEx pinned in `heex-parity` with a reason (LiveView `handle_event` round-trip is a different topology), Feliz attempted / fail-fast per M-T6.15.
**Client-side column SORT — landed + build-gate-verified on all 4 JSX targets (PR #1890, slices 1–4):**
- The optional `WalkerTarget` seams `renderSortableHeader` + `renderSortedRows` (`src/generator/_walker/target.ts`); `Table(sortKey:, sortDir:, Column(..., sortable:, field:))` in `src/generator/_walker/primitives/table.ts`, **gated** so an un-ported target stays byte-identical.
- **React** (`tsxTarget`) — inline `[...rows].sort` with `as`-cast comparator. **Vue/Svelte/Angular** — a shared `sortRows()` helper (`src/generator/_frontend/table-sort-helper.ts` → `src/lib/table-sort.ts`) because their strict templates reject the inline cast; imported via the `usesTableSort` walker flag (Angular re-exposes it as a `protected readonly` member — templates can't call free imports). Signals/`$state`/`ref` write idioms per target.
- **Verified end-to-end** (not just structural): React (react tsc), Vue (`vue-tsc` + `vite build`), Svelte (`svelte-check` + `vite build`), Angular (`ng build`) all green on a generated sortable-table project. Tests: `test/generator/{react,vue,svelte,angular}/table-sort.test.ts`.
- **Feliz + HEEx** gracefully degrade to a plain (unsorted) table — the seams are absent, so the sort args are ignored (output correct, not broken). Feliz doesn't map cleanly (Elmish `renderStateWrite → "()"`; sort needs Set-Msg/update plumbing + Fable verification); HEEx needs a LiveView `handle_event` round-trip. Both pinned as known sort gaps.
- **Scaffold wiring LANDED (slice 5):** `scaffoldList` marks every column `sortable:` with an explicit `field:` and threads `sortKey:`/`sortDir:` into the Table; the List page declares the two string state fields. Scaffold list pages sort out of the box on the 4 JSX frontends. Feliz/HEEx carry the two extra state fields as harmless unused model-fields / mount-assigns (verified: React scaffold `tsc` green, Feliz + Phoenix scaffolds generate).
- **a11y fix (slice 5 follow-up):** the sortable header was a `<span onClick>`, which trips `svelte-check --fail-on-warnings` (the `generated-svelte-build` gate) + axe. Now a real `<button>` (keyboard-focusable, implicit ARIA role, reset chrome) on all 4 JSX targets.
**Client-side PAGINATION — landed + build-gate-verified on all 4 JSX targets (slice 6):**
- New **optional** `WalkerTarget` seam `renderPager(spec)` + `PagerSpec` (page ref, `pageSize`, `totalExpr`); `Table(page:, pageSize:)` in `table.ts` slices rows to the active window (built generically from `renderStateRead`) and appends a Prev / "Page N of M" / Next pager. **Gated** so an un-ported target renders unpaged (byte-identical). The pager total derives from the post-sort array (non-null when sort is active) so no redundant `?? []` guard is emitted (a double guard is a strict-Angular TS2869 error).
- **int-typed page state:** generalized `page()`/`stateBlock()` (`StateFieldSpec`) to carry typed fields + literal inits, and taught the **Vue page-shell** to honour `field.init` (Angular/Svelte/React already did). The scaffold list declares a 1-based `pageNum: int` state (named `pageNum`, not `page` — reserved keyword, would break `unfold`) and threads `page:`/`pageSize: 10` into the Table.
- **Verified end-to-end:** React (tsc), Vue (`vue-tsc` + `vite build`), Svelte (`svelte-check` 0-warnings + `vite build`), Angular (`ng build`) all green on generated paged projects. Feliz/HEEx degrade (extra `pageNum`/`sortKey` model-fields, verified generate). Tests: `test/generator/{react,vue,svelte,angular}/table-pagination.test.ts`.
**Server-driven PAGINATION + SORT — landed (slice 9, coordinated with M-T2.6):** the auto-`findAll` is now paged-by-default (`ensureFindAll` → `paged<T>`), so the scaffold list consumes the envelope server-side: `useAll<X>({page, pageSize, sort, dir})` reads `.data.items`, pages off `.data.totalPages`, and sends `?page=&pageSize=&sort=&dir=` to the whitelisted-ORDER-BY route across all five backends. `QueryView paged:` + `Table serverPaged:` gate the unwrap; the client-pager primitive stays valid for non-paged array sources / explicit finds. HEEx unwraps `.items` (sort/pager pinned, heex-parity reason); Feliz decodes the `items` field (Model stays `'T list`, page 1, pager pinned). **Acceptance e2e landed:** `test/behavioral/pagination.mjs` seeds 1000 rows over the real HTTP surface and asserts the paged window/counters/ORDER BY end-to-end (gated in `behavioral-e2e.yml`).
**Remaining slices:** (7) **client-side filter** (or fold into the existing find-filter bar); (8) Feliz/HEEx sort + pagination (Elmish `Set-Msg`/update plumbing + LiveView `handle_event`) if de-pinned. Status stays `partial` for these two tails; the paged/sorted core (slices 1–6, 9) + acceptance e2e are done.
Sources: [pagination-design-note](../old/proposals/pagination-design-note.md), [completeness-audit Tier 1](../audits/completeness-audit-2026-07.md), weak-spots §1. Touches: `src/generator/_walker/primitives/table.ts`, walker targets, all pack `primitive-table.hbs`.
Acceptance: showcase list pages page/sort against a seeded 1k-row backend; all `generated-*-build` + e2e gates green.

## M-T1.2 — `FileUpload` field primitive + `File` type — `open` · **L** · P1
No binary/file story anywhere. Needs the `File`/`Upload` day-one construct ([quickstart §5](../old/proposals/quickstart-and-day-one-batteries.md)) on the backend (objectStore resource verbs already ship — see M-T4.6) and a `FileUpload` input primitive across walkers/packs.
Depends: resource verb layer (shipped), M-T4.6 for storage wiring.

## M-T1.3 — Charts beyond `Stat` — `open` · **M** · P2
A minimal `Chart` primitive (line/bar over a collection expr). Keep the set closed and small; HEEx renderer required or pinned (heex-parity gate).

## M-T1.4 — Frontend extern parity: Angular + HEEx + Vue/Svelte components — `partial` · **M** · P1
`component extern` ships React-only (Tier 1); `function extern` React/TS. Bring `component`/`function extern` to Vue/Svelte/Angular, and design the HEEx/LiveView binding (or an honest `loom.extern-component-framework-mismatch` gate). Also: Stage 3 `hook … extern` stays demand-pulled.
Sources: [extern-component-escape-hatch](../old/proposals/extern-component-escape-hatch.md), [extern-function-hook-escape-hatch](../old/proposals/extern-function-hook-escape-hatch.md) (Stage 2 Phoenix `@spec`), global-plan T3.15.

## M-T1.5 — Region-level customization / UI unfold — `open` · **L** · P1 (design-first)
Today customization is whole-file (`.loomignore`, scaffold-once) or whole-component ejection; `unfold` explicitly excludes `ui` hosts. Design a middle path: named override slots on generated pages, or page-level unfold-to-`.ddd`-source. This is the cliff-softener; write the proposal before code.
Sources: weak-spots §1, [unfold-macro.ts](../../src/language/lsp/unfold-macro.ts) (ui exclusion), page-metamodel §14.

## M-T1.6 — Forms tail — `partial` · **M** · P2
Remaining from the forms family: flat-key schema restructure + per-action `FieldMap satisfies StrictFieldMap` (gated on a real flat≠nested need), `option`-field "leave unchanged" toggle (blocked on M-T5.3 option carrier), WizardForm, async refines, optimistic updates.
Sources: [frontend-acl](../old/proposals/frontend-acl.md) Phases 3–4, [loom-forms](../old/proposals/loom-forms.md) #3/#4/#7, [frontend-acl-implementation](../old/plans/frontend-acl-implementation.md).

## M-T1.7 — Async actions steps 3–4 — `open` · **M** · P2
`attempt {}` railway + `onError` sugar + `spawn` (fire-and-forget / optimistic UI) with `loom.bind-on-spawn`/`loom.spurious-onerror`; then `async` keyword + transitive inference + action→action awaiting.
Sources: [async-actions-and-effects](../old/proposals/async-actions-and-effects.md) steps 3–4, [named-actions-and-stores](../old/proposals/named-actions-and-stores.md) stages 2–4.

## M-T1.8 — Global error boundary + failure sink (frontend half) — `open` · **M** · P2
Unhandled-`await` terminus + render-time error boundary + default fallback page per framework; `errors {}` declarative override; backend `traceId` in the problem+json contract.
Sources: [error-handling-and-failure-sink](../old/proposals/error-handling-and-failure-sink.md); backend half in M-T5.2.

## M-T1.9 — `store` lifetimes — `done` (verified 2026-07-13) · —
The `loom.store-lifetime-unsupported` gate is RETIRED (`store-checks.ts:12,77` — "supported on every frontend"); the parity register's "gated on all targets" row was stale. Residual worth a look before deleting this entry: LiveView in-memory tier + `flow`/`machine` stay demand-pulled per [frontend-state-management](../old/proposals/frontend-state-management.md).

## M-T1.10 — Realtime beyond toast — `partial` · **L** · P2
`on <channel>.<Event>` handlers are toast-only (`loom.ui-handler-unsupported`); SSE ships on Hono+React/Vue/Svelte only. Slices: richer handler bodies (refetch/invalidate binding), .NET + Phoenix realtime wire, then rooms/edge-relay/policy-derived routing (blocked on T3 authorization item 3).
Sources: [channels](../old/proposals/channels.md) realtime sections, global-plan T3.7.

## M-T1.11 — i18n — `open` · **XL** · P2
Nothing exists. Phases 1–7 per the proposal pair: extraction skeleton → React runtime → `ddd i18n sync` (content-hash keys, D-I18N-KEY) → pack chrome catalogs → invariant `message:` keys → non-React backends → validator-message centralisation. Prereq: [i18n-strings](../old/proposals/i18n-strings.md) Phase 1 (template-literal → ICU lowering + `loom.user-visible-concat`).
Sources: [i18n](../old/proposals/i18n.md), [i18n-strings](../old/proposals/i18n-strings.md).

## M-T1.12 — Accessibility: from contract to emission — `partial` · **L** · P2 ⚠ verify-first
`A11yContract` data + heading-level derivation + skip-link/landmark work landed (incl. Phoenix #1785); the rest of the proposal's Phases 2–5 (role/name/label association, Modal focus trap, live regions, author hints + `loom.a11y-*` codes, axe gate breadth, pack contrast gate) is open. Re-audit what shipped before scoping.
Sources: [accessibility](../old/proposals/accessibility.md), `generated-a11y.yml`.

## M-T1.13 — Scaffolded navigation (menu reform) — `open` · **M** · P3
Remove implicit sidebar derivation + per-page `menu {}` bag; every entry traces to a real, unfold-able `menu {}` block (scaffold-materialized codemod so no UI silently loses its sidebar). Resolve the `menu` keyword overload. (= old global-plan S3.)
Sources: [scaffolded-navigation](../old/proposals/scaffolded-navigation.md).

## M-T1.14 — Angular tails — `partial` · **S** · P2
`X id` select/combobox is DONE (verified 2026-07-13: `angular/form-fields.ts:226-247` renders mat-select/p-select/native select via hoisted `useAll<X>()`). Remaining: page-`requires`/nav-link auth gating parity.
Sources: [angular-frontend](../old/proposals/angular-frontend.md) tail.

## M-T1.15 — Richer list filter inputs — `open` · **S** · P3
Enum selects, numeric ranges, paged pickers on scaffolded list pages (global-plan T3.14). Subsumed by M-T1.1 where it overlaps; keep for the non-Table inputs.

## M-T1.16 — Feliz polish — `in-flight` · **M** · P3
Slices 1–8 landed; **design system LANDED** — the Feliz pack now emits daisyUI component classes (`btn`/`card`/`table`/`badge`/`alert`/`collapse`/…) and the project ships a real Tailwind + daisyUI build (`styles.css` + `tailwind.config.js` + `postcss.config.js`, linked from `index.html`); matches the in-repo HEEx daisyUI pack. **Theme picker LANDED** — a feliz deployable's `design: "<theme>"` selects any daisyUI theme (validated against the built-in set, default `corporate`); drives `data-theme` + the compiled themes list. **App-shell navbar LANDED** — a multi-page routed ui gets a persistent daisyUI `navbar` (brand + one item per top-level page) wrapping the router. **Per-field form validation LANDED** — alongside the whole-form submit-gate, each required field now carries a touched `onBlur` + an inline `text-error` message revealed once blurred (a `<Form>Touched: Set<string>` in the Model, a `Touch<Form>` Msg/arm, and `Validation.<form><Field>Error` fns) — the Elmish analogue of react-hook-form's per-field `errors.<f>.message`; verified compiling via `dotnet fable`. Remaining (assessed as **deliberate F#/Elmish adaptations, not gaps** — see below): typed in-flight form state (Feliz uses string state for controlled inputs; the JSX frontends use uncontrolled RHF+valueAsNumber — typing it would regress partial-input UX), enum DU wire decoder (fights F#'s strict string concatenation — `"x" + enumField` has no implicit ToString; the string wire form is correct for F#), per-page sub-models (single combined Elmish Model works), multi-param routes (single-`:id` route machinery is hardcoded pervasively; scaffolds never emit multi-param). Rule-specific validation messages (min/max/length/pattern via the shared `invariant-classify` pipeline) is the natural follow-up to the required-field slice.
Sources: [feliz-frontend-build](../old/plans/feliz-frontend-build.md).

## M-T1.17 — Builder polish — `open` · **S** · P3
Living backlog remnants: auto-layout (dagre/elk), nested grouping, add-target context picker, drag-rebind edges.
Sources: [builder-roadmap](../old/plans/builder-roadmap.md).
