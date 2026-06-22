# Angular `X id` form fields → select (parity gap #12)

**Status:** claimed / in progress. **Branch:** `claude/recent-prs-gaps-54kmcg`.

## The gap (audited, confirmed on fresh `main`)

A cross-aggregate reference field (`customerId: Customer id`) in a form should
render a **select/combobox** populated from the referenced aggregate's
`findAll`, letting the user pick a row — not a free-text input where they type a
raw UUID.

| Frontend | `X id` form widget | Verdict |
|---|---|---|
| React | `<Select>` fed by `useAll<X>()` (`field-input-id-select`) | ✅ reference |
| Vue | same, via shared `walkBody` | ✅ |
| Svelte | same, via shared `walkBody` | ✅ |
| **Angular** | **plain text `<input>`** — no `id` branch | ⚠️ **silent gap** |

This is a **⚠ partial / silent UX gap** (bucket c): valid `.ddd` passes
validation and emits an Angular form that makes the user type a UUID. No data
loss, but broken parity with the other three SPAs. No validator change is
needed (the feature works on the other frontends; Angular must emit it too).

## Divergence point

- Shared reference seam: `src/generator/_walker/form-fields-vm.ts:51-85` —
  `inner.kind === "id"` with a resolvable `target.displayDerived` →
  `field-input-id-select`; text fallback only when the target is unresolved or
  has no derived display.
- Angular: `src/generator/angular/form-fields.ts` `fieldInput()` branches on
  `enum`/`bool`/numeric/datetime; an `id`-typed field falls through to the
  final plain text input. No `t.kind === "id"` arm; `controlInit()` returns
  `null` for it (fine for a select).
- Consumers of the gap: `create-form.ts`, `operation-form.ts`, `modal.ts`,
  `workflow-form.ts` (all four Angular form forks).
- Dead page-object branch (already correct, currently unreachable):
  `src/generator/_frontend/page-objects-builder.ts:289-309` — Angular requests
  `selectStyle: "combobox"` (`angular/index.ts:277-279`) but the form never
  emits matching `-option-<id>` testids.

## Plan

1. `angular/form-fields.ts` `fieldInput()` — add an `id` arm before the text
   fallback, mirroring the `form-fields-vm.ts:51-85` gate (select when the
   target has a `displayDerived`, text fallback otherwise). Emit per-pack
   markup: `<mat-select>` (angularMaterial) / `<p-select>` (primeng) /
   `<select>` (spartanNg/plain), options from a `useAll<Target>()` resource,
   each option carrying `data-testid="${ns}-input-${name}-option-${o.id}"` to
   match the page-object locator.
2. Wire the `useAll<Target>` query into the four Angular form shells (the React
   seam registers `useAll${plural(target)}` at `_walker/primitives/forms.ts`).
3. The shared combobox `fillBlock` page object becomes live automatically once
   matching testids emit — no page-object change.
4. Tests: an Angular form-builder generator test asserting the `id` field
   renders a select with the option testids; `LOOM_REACT_BUILD`-style Angular
   build gate stays green; the runtime e2e combobox fill branch now exercises.

Reference to mirror: React `field-input-id-select.hbs` + `idTargetHookVar` /
`useAll<X>` wiring.
