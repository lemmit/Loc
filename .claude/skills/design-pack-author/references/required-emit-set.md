# The required-emit set and WALKER_PRIMITIVES coverage

This is the operational answer to "what must my pack emit, and how do I know it's
complete?". Two layers gate completeness:

1. **The required-emit set** — `REQUIRED_PRIMITIVES[format]` in
   `src/generator/_packs/required-primitives.ts`. Enforced at load time by
   `compilePack` (`src/generator/_packs/loader.ts`) and by
   `test/platform/pack-required-primitives.test.ts`. A missing name is a
   *named* load-time error.
2. **WALKER_PRIMITIVES coverage** — `WALKER_PRIMITIVES` in
   `src/generator/_walker/registry.ts`. The walker can dispatch any of these on
   your format; the required set is *derived from but not identical to* this
   table (it subtracts the inline-rendered ones per format). A primitive the
   walker dispatches but your pack doesn't emit is the #1478 crash class.

## Table of contents
- [How the gate fires](#how-the-gate-fires)
- [The per-format required set](#the-per-format-required-set)
- [How to read what's missing](#how-to-read-whats-missing)
- [WALKER_PRIMITIVES coverage checklist](#walker_primitives-coverage-checklist)
- [The #1478 lesson — exemptions are decisions, not gaps](#the-1478-lesson)

## How the gate fires

`compilePack` builds the `templates` map (from `manifest.emits` + inherited
shared sources), then:

```ts
const required = REQUIRED_PRIMITIVES[format];           // format = manifest.format ?? "tsx"
const missing = flattenRequired(required).filter((name) => !templates.has(name));
if (missing.length > 0) throw new Error(`… missing required template(s): ${missing.join(", ")}. …`);
```

`flattenRequired` concatenates `core + shell + fieldInput? + form?`. So the gate
is the union of those four lists for your `format`. The throw names every gap —
this is your worklist. There is **no fallback chain**: a missing template is a
hard error, by design (lazy `pack.render` resolution would surface the gap as a
confusing render-time failure deep in the walker instead of a load-time message).

The opt-out (`loadPack(dir, { validateRequired: false })`) exists ONLY for
narrow fixture tests that probe one manifest field; it does **not** flow through
`pack.json`, so a real pack can't bypass the gate.

## The per-format required set

All lists are defined in `required-primitives.ts`. Summary as of this writing —
**read the file for the live set; it grows as primitives land**:

### `core` — `SHARED_PRIMITIVES` (every format) + format extras

`SHARED_PRIMITIVES` (required for tsx, heex, svelte, vue; angular minus
`primitive-form-of`):

```
primitive-alert, primitive-anchor, primitive-avatar, primitive-badge,
primitive-bold, primitive-breadcrumbs, primitive-button, primitive-card,
primitive-container, primitive-date-display, primitive-divider, primitive-empty,
primitive-enum-badge, primitive-field, primitive-form-of, primitive-grid,
primitive-group, primitive-heading, primitive-id-link, primitive-image,
primitive-inline-code, primitive-italic, primitive-key-value-row, primitive-loader,
primitive-money, primitive-multiline-field, primitive-number-field, primitive-paper,
primitive-password-field, primitive-query-view, primitive-select-field,
primitive-skeleton, primitive-stack, primitive-stat, primitive-table, primitive-tabs,
primitive-text, primitive-toggle, primitive-toolbar
```

`TSX_ONLY_PRIMITIVES` (added to `core` for tsx, svelte, vue; angular minus
`primitive-modal`; **not** heex):

```
primitive-code-block, primitive-icon, primitive-modal, primitive-section, primitive-sticky
```

> `primitive-section` and `primitive-sticky` are in this list *because of #1478*.
> They are dispatched by the JSX-family walker on every format, so omitting them
> crashes codegen — they MUST be required for any pack whose walker renders them.
> HEEx is exempt only because its walker emits these inline (no pack template).

### `shell` — `SHARED_SHELL` (every format) + format extras

```
app-shell, format-helpers, main, package-json, theme, tsconfig, vite-config
```

- **svelte** adds `svelte-config` (SvelteKit's `svelte.config.js`).
- **angular** replaces `vite-config` with `angular-json` (CLI workspace) and
  drops it from the shared list — angular's `shell` is the explicit list in the
  manifest (`app-shell, format-helpers, main, package-json, theme, tsconfig,
  angular-json`).

### `fieldInput` — `TSX_FIELD_INPUT` (tsx, svelte, vue only)

```
field-input-array, field-input-bool, field-input-datetime, field-input-decimal,
field-input-enum-select, field-input-id-select, field-input-id-text, field-input-int,
field-input-money, field-input-string, field-input-valueobject
```

Not required for **heex** (Phoenix renders form inputs inline via the HEEx walker
from the Ecto schema / wire shape) or **angular** (typed Reactive Forms emitted inline
via walker seams in `src/generator/angular/*-form.ts`).

### `form` — `TSX_FORM` (tsx, svelte) / `+ op-dialog` (vue)

```
form-default-onsubmit, form-of-decls, form-op-decls, form-op-module,
form-runs-decls, realtime-toast
```

- **vue** adds `op-dialog` (the operation-modal wrapper the page shell renders —
  `v-dialog` on vuetify, the `Dialog` components on shadcnVue).
- **heex** and **angular** have no `form` set (same reasons as `fieldInput`).

### The format → required-set map at a glance

| Format | core | shell | fieldInput | form |
|---|---|---|---|---|
| `tsx` | SHARED + TSX_ONLY | SHARED_SHELL | yes | TSX_FORM |
| `svelte` | SHARED + TSX_ONLY | SHARED_SHELL + `svelte-config` | yes | TSX_FORM |
| `vue` | SHARED + TSX_ONLY | SHARED_SHELL | yes | TSX_FORM + `op-dialog` |
| `angular` | SHARED−`form-of` + TSX_ONLY−`modal` | explicit (`angular-json`, no `vite-config`) | — | — |
| `heex` | SHARED only | SHARED_SHELL | — | — |

## How to read what's missing

Don't hand-diff. Make the loader tell you:

- **Fastest** — add your pack to `BUILTIN_PACKS` in
  `test/platform/pack-required-primitives.test.ts` and run
  `npx vitest run test/platform/pack-required-primitives.test.ts`. A gap surfaces
  as `<pack>: missing template "<name>"`.
- **Or** generate a system that uses your pack
  (`node bin/cli.js generate system <your.ddd> -o /tmp/out`) — `compilePack`
  throws during generation with the full missing-name list.
- **Or** call `loadPack(resolvePackDir("<family>@v1"))` from a Node one-liner
  against `out/` (after `npm run build`).

Each surfaces the SAME named-gap error from `compilePack`. Add the missing names
to `emits`, create the `.hbs` files, repeat until clean.

## WALKER_PRIMITIVES coverage checklist

The required set is the *floor*. The real invariant is that every primitive the
body walker dispatches on your format has a real template. Cross-check
`WALKER_PRIMITIVES` (`src/generator/_walker/registry.ts`) against your `emits`:

1. List the registry entries whose `tsx` renderer is defined (the JSX-family
   walker dispatches these — `Stack`, `Group`, `Grid`, `Container`, `Tabs`,
   `Toolbar`, `Empty`, `Card`, `Paper`, `Breadcrumbs`, `KeyValueRow`, `Section`,
   `Sticky`, `Field`, `NumberField`, `PasswordField`, `Toggle`, `MultilineField`,
   `SelectField`, `Loader`, `Anchor`, `Image`, `Avatar`, `Heading`, `Text`,
   `Bold`, `Italic`, `InlineCode`, `Button`, `Stat`, `Badge`, `Divider`, `Table`,
   `Money`, `DateDisplay`, `EnumBadge`, `IdLink`, `Skeleton`, `Alert`, `QueryView`,
   `Modal`, `CodeBlock`, `Icon`, the form leaves, `Action`, `For`). `Tab` and
   `Column` are `group: "sub"` — consumed inline by `Tabs`/`Table`, no top-level
   template.
2. For each, confirm your pack emits the matching `primitive-*` template (the
   logical name is the kebab-case of the primitive — `Section` →
   `primitive-section`, `KeyValueRow` → `primitive-key-value-row`).
3. Anything dispatched-but-not-emitted is a #1478-class gap. The required set
   catches most via Step 3, but the registry is the authoritative dispatch
   surface — if a new primitive landed in the registry but not yet in the
   required set, it can still crash your pack.

The mirror gate `test/language/type-system/walker-stdlib-completeness.test.ts` pins
`src/language/walker-stdlib.ts` to the registry — that's the *language-side*
admissibility, not the pack-side template. Your job is the pack-side: a template
for every dispatched primitive.

## The #1478 lesson

#1478's HIGH finding: `Section`/`Sticky` were dispatched via `pack.render` with
no presence guard, so a pack missing them passed validation but crashed codegen.
The structural fix was to add them to the required set
(`TSX_ONLY_PRIMITIVES`) so the load-gate names the gap. The authoring lesson:

- **A silent gap is the bug.** Validation passing ≠ codegen safe — the validator
  accepts every primitive on every target; only the pack-side template gate
  catches an omission.
- **An exemption must be a documented decision.** When a primitive genuinely
  can't render on your format (HEEx renders `Section`/`Sticky`/`Modal`/`Icon`/
  `CodeBlock` inline; Angular subtracts the form family), the exemption lives in
  `required-primitives.ts` with a comment explaining *why* — read how
  `TSX_ONLY_PRIMITIVES` and the `angular`/`heex` entries document each one. Don't
  just leave a template out and hope no `.ddd` uses it.
