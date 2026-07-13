# T1 — UI & frontend ceiling

*The product's #1 weak spot ([weak-spot review](../audits/architecture-weak-spots-2026-07.md) §1): the scaffolded UI is excellent until the closed primitive set runs out, then customization is an all-or-nothing ejection. These missions raise the ceiling and soften the cliff.*

## M-T1.1 — Paged, sorted, filtered Table — `open` · **L** · P1
The wire ships the `paged` carrier; no frontend consumes it. `Table`/`QueryView` fetch entire collections; no column sort, no interactive filter. Add pagination/sort/filter to the `Table` primitive across the four JSX walkers + HEEx and the pack templates (server-driven via `paged` + query params where the source supports it, client-side fallback otherwise).
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

## M-T1.9 — `store` lifetimes + LiveView state tiers — `partial` · **M** · P2
`persist:`/`sync:` parse but are gated (`loom.store-lifetime-unsupported`) on all five targets; LiveView `url` tier via `handle_params`/`push_patch`. Ship `local` first if it de-risks.
Sources: [frontend-state-management](../old/proposals/frontend-state-management.md), parity register frontend row 2.

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

## M-T1.14 — Angular tails — `in-flight` · **S** · P2
`X id` form fields render as free-text UUID inputs (should be select/combobox; claimed on `claude/recent-prs-gaps-54kmcg`); page-`requires`/nav-link auth gating parity.
Sources: [angular-x-id-select](../old/plans/angular-x-id-select.md), [angular-frontend](../old/proposals/angular-frontend.md) tail.

## M-T1.15 — Richer list filter inputs — `open` · **S** · P3
Enum selects, numeric ranges, paged pickers on scaffolded list pages (global-plan T3.14). Subsumed by M-T1.1 where it overlaps; keep for the non-Table inputs.

## M-T1.16 — Feliz polish — `in-flight` · **M** · P3
Slices 1–8 landed; remaining: pack coverage growth, modal open-state, typed form state + validation, enum DU wire decoder, per-page sub-models, multi-param routes.
Sources: [feliz-frontend-build](../old/plans/feliz-frontend-build.md).

## M-T1.17 — Builder polish — `open` · **S** · P3
Living backlog remnants: auto-layout (dagre/elk), nested grouping, add-target context picker, drag-rebind edges.
Sources: [builder-roadmap](../old/plans/builder-roadmap.md).
