# Accessibility as a first-class citizen

> Status: **proposal**. No a11y infrastructure exists today — a repo-wide
> search for `aria-`, `a11y`, `role=`, `axe` across the frontend generators
> ([src/generator/_walker/](../../src/generator/_walker/),
> [src/generator/react/](../../src/generator/react/), the design packs under
> [designs/](../../designs/)) finds nothing systematic. This doc defines how
> Loom makes accessibility a property of the compiler, not a per-app retrofit.
>
> Sibling reading: [`i18n.md`](./i18n.md) and [`frontend-acl.md`](./frontend-acl.md)
> — the same "derive a cross-cutting concern from the closed primitive set"
> shape. a11y is the strongest instance of that pattern.

## The thesis

Accessibility is **hard by hand and mechanical for Loom**, for one reason: the
page DSL is a **closed, semantically-named primitive library**
([src/generator/_walker/registry.ts](../../src/generator/_walker/registry.ts) —
52 primitives, each pinned by
[walker-stdlib-completeness.test.ts](../../test/language/type-system/walker-stdlib-completeness.test.ts)).
A human writes arbitrary `<div>`s and forgets the `aria-label`; Loom knows that
`Button` is a button, `Table` is a grid, `Modal` is a dialog, `Field` has a
label, `Image` needs alt text, `Tabs` owns a `tablist`/`tab`/`tabpanel` triad.
Every fact a correct a11y implementation needs — role, accessible name,
keyboard pattern, heading level, landmark — is **already derivable from the IR**.

So accessibility is not a feature users opt into; it is the **floor every emit
clears by default**. Unlike SSR (a knob you flip — [`nextjs-frontend.md`](./nextjs-frontend.md)),
a11y is always-on, with a *tiny* explicit surface only for the handful of facts
Loom genuinely cannot derive (chiefly human-authored alt text).

This is the single highest-leverage "free knob" for Loom's actual output:
authenticated line-of-business apps, where a11y is **universal and increasingly
a legal requirement** (WCAG 2.2 AA is the common contractual/legal bar — ADA,
Section 508, EN 301 549; the EU Accessibility Act raised the stakes for products
sold in the EU from mid-2025). It helps every app Loom generates, public-facing
or internal — the opposite of SSR, which only pays off for the public minority.

## Goals

- **Zero-effort default.** A fresh `ddd generate system` produces a
  WCAG 2.2 AA-conformant app. No developer step, no annotation, no knowledge of
  ARIA required.
- **Correct by construction, not by lint.** The accessible markup is *emitted*,
  not retro-checked. axe-core in CI is a tripwire, not the mechanism.
- **One contract, every frontend.** The a11y obligations of each primitive live
  once in the registry; React/Vue/Svelte/HEEx targets each honour the same
  contract through their design pack.
- **Compile-time enforcement of the underivable.** The few facts Loom can't
  derive (alt text, an icon-only control's name) are *required at validate time*
  with a `loom.a11y-*` code — never a silent gap shipped to a screen reader.
- **Exhaustive coverage no hand-written app gets.** Because output is generated,
  axe runs against *every* example × design-pack combination, not a sampled few.

## Non-goals (this proposal)

- **Bespoke a11y for escape-hatch code.** An `extern` component
  ([`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md)) is
  the author's responsibility, exactly as its server/client boundary is under
  SSR. Loom derives a11y only for primitives it owns.
- **AAA conformance.** AA is the target; AAA is opt-in per-app polish.
- **Manual-audit replacement.** Automated coverage (axe) catches the
  machine-detectable ~57%; a human audit is still recommended for production.
  Loom guarantees the machine-detectable floor.
- **Reduced-motion / high-contrast user preferences** beyond emitting the
  `prefers-reduced-motion` / `prefers-contrast` media hooks in the pack theme.

## Layered design

Three layers, mirroring [`i18n.md`](./i18n.md).

### Layer 1 — the per-primitive a11y contract (the 90%)

Each primitive gains an `a11y` field on its `PrimitiveDef`
([src/generator/_walker/registry.ts](../../src/generator/_walker/registry.ts)).
It declares the semantic the walker must emit — the single source of truth, the
same SSOT move i18n uses for `userVisible` slots:

```ts
Button:  { group: "layout", a11y: { role: "button", needsName: true, keyboard: "activate" }, tsx: emitButton, heex: renderButtonHeex },
Modal:   { group: "layout", a11y: { role: "dialog", modal: true, focus: "trap-restore" }, tsx: emitModal, ... },
Tabs:    { group: "layout", a11y: { role: "tablist", keyboard: "arrows", owns: "Tab" }, tsx: emitTabs, ... },
Field:   { group: "layout", a11y: { labelled: "associate" }, tsx: emitField, ... },
Image:   { group: "layout", a11y: { needsAlt: true }, tsx: emitImage, ... },
Alert:   { group: "layout", a11y: { role: "alert", live: "assertive" }, tsx: emitAlert, ... },
Heading: { group: "layout", a11y: { headingLevel: "derive" }, tsx: emitHeading, ... },
Divider: { group: "layout", a11y: { role: "separator" }, tsx: emitDivider, ... },
Stat:    { group: "layout", a11y: "presentational" },   // explicitly nothing required
```

A completeness test pins it: **every primitive declares an `a11y` contract or is
explicitly `"presentational"`** — drift fails CI, exactly like the
[required-primitives gate](../../src/generator/_packs/required-primitives.ts).
Adding a primitive without an a11y decision becomes a compile error, not a
silent screen-reader gap.

### Layer 2 — design-pack a11y obligations

The pack template for each primitive must render the semantic element + ARIA the
contract declares, and the pack **theme** must clear WCAG-AA contrast and ship a
visible `:focus-visible` style. Most of this is *free* for packs that wrap an
already-accessible component library (Mantine, MUI, Chakra, Vuetify all ship
accessible primitives); the gate catches regressions and hand-rolled packs
(shadcn variants) that don't.

The existing [required-emit gate](../../src/generator/_packs/required-primitives.ts)
is extended: a pack that emits `primitive-button` without a `<button>`/`role`
fails `loom.a11y-pack-incomplete` at `compilePack` time — the a11y twin of "a
pack missing `primitive-button` fails at load, not at first render."

### Layer 3 — derived whole-page structure

Computed at enrich/codegen from the page tree + generated data layer, no author
input:

- **Heading levels.** `Heading` emits `<h1>` once at page top, `<h2>`/`<h3>`
  derived from `Section`/`Card` nesting depth — never a skipped level. Humans
  get this wrong constantly; Loom derives it from structure.
- **Landmarks + skip link.** The generated app shell emits
  `<header>`/`<nav aria-label>`/`<main>`/`<footer>` and a "skip to content"
  link by default.
- **Live regions.** Generated async surfaces announce: form success/error →
  `role="status"`/`role="alert"`, `Loader`/`Skeleton` → `aria-busy`, validation
  errors → `aria-describedby` + `aria-invalid` on the field. (On LiveView this
  is a *natural* fit — a server-pushed `aria-live` region just works with the
  diff model.)
- **Focus management.** `Modal` traps focus on open and restores on close;
  route navigation moves focus to `<main>`/`<h1>`.

## Author surface — nothing, plus three explicit hints

Default: the author writes the **same `.ddd`** and gets conformant output. The
only explicit surface is the small set of facts Loom cannot derive — mirroring
i18n's implicit-default + explicit-override split:

| Hint | On | Why underivable |
|---|---|---|
| `alt: "..."` | `Image`, `Avatar` | Alt text is human content, not structure |
| `decorative` | `Image`, `Icon` | Marks `alt=""` / `aria-hidden` deliberately |
| `label: "..."` | icon-only `Button` / `Action` | When the op name isn't a good screen-reader label |

Everything else (the accessible name of a labelled `Action o.cancel`, the
`tablist` wiring, the heading level, the field-label association) is derived.

## Worked examples

### 1 — icon-only action, avatar, heading

```ddd
page OrderShow(o: Order) {
  Toolbar {
    Action o.cancel { Icon { "x" } }     // icon-only → name derived from the op
  }
  Avatar { src: o.customer.photo }        // alt derived from the customer's display
  Heading { "Order summary" }             // level derived: top of page → h1
}
```

Generated React (Mantine pack) — accessible by construction:

```tsx
<Group role="toolbar" aria-label="Order actions">
  <ActionIcon aria-label="Cancel order" onClick={cancel}>
    <IconX aria-hidden />               {/* decorative glyph hidden from AT */}
  </ActionIcon>
</Group>
<Avatar src={o.customer.photo} alt={`${customerDisplay(o.customer)}`} />
<Title order={1}>Order summary</Title>
```

`aria-label="Cancel order"` is derived from the `cancel` operation on `Order`;
the icon is `aria-hidden`; the heading is `<h1>` because it is the page's top
heading — none of it authored.

### 2 — form validation + live error association

```ddd
page NewOrder { CreateForm Order }
```

Generated React — label association + error wiring, derived from the aggregate's
fields and invariants (the same `message:` keys i18n extracts):

```tsx
<label htmlFor="customerName">Customer name</label>
<TextInput
  id="customerName"
  aria-invalid={!!errors.customerName}
  aria-describedby={errors.customerName ? "customerName-error" : undefined}
  {...form.getInputProps("customerName")}
/>
{errors.customerName && (
  <Text id="customerName-error" role="alert">{errors.customerName}</Text>
)}
```

The HEEx (LiveView) emit of the same announcement is a one-liner the diff model
makes correct for free:

```heex
<div role="status" aria-live="polite"><%= @flash[:info] %></div>
```

## Validation — the `loom.a11y-*` codes

Compile-time a11y linting, free because the vocabulary is closed — the analog of
how Loom already type-checks expressions. All fail-fast at validate time:

| Code | Fires when |
|---|---|
| `loom.a11y-missing-alt` | `Image`/`Avatar` with no derivable alt and no `alt:`/`decorative` |
| `loom.a11y-icon-only-no-name` | icon-only `Button`/`Action` whose accessible name can't be derived and has no `label:` |
| `loom.a11y-pack-incomplete` | a design-pack template omits the role/ARIA its primitive's contract declares |
| `loom.a11y-contract-missing` | a registered primitive has no `a11y` contract (completeness test) |
| `loom.a11y-theme-contrast` | a user `theme {}` colour whose fill shade has no readable text colour (WCAG-AA) — a compile-time **warning** (the pack picks the text colour); the author-override twin of the per-pack token-contrast gate |

These never *downgrade* — an unnameable control is an error, never a control
shipped without a name (the same fail-fast-not-silent rule the backend parity
gates enforce, [CLAUDE.md](../../CLAUDE.md)).

## Pipeline integration

Folds into the ten-phase pipeline without crossing layer boundaries:

| Phase | Change |
|---|---|
| ④ AST validate | `loom.a11y-missing-alt` / `loom.a11y-icon-only-no-name` on the page DSL. |
| ⑥ enrich | Derive heading levels from `Section`/`Card` nesting; stamp `PageIR` with the landmark/skip-link plan. |
| ⑦ IR validate | `loom.a11y-contract-missing` completeness check against the registry. |
| ⑧ codegen | Walker emits role/ARIA/label-association per the primitive contract; design packs render the declared semantic element; live regions + focus management wired. |
| ⑨ system | App-shell landmarks + skip link; pack contrast/focus gate (`loom.a11y-pack-incomplete`). |

The contract lives in `_walker/registry.ts` (framework-neutral); each
`WalkerTarget` ([src/generator/_walker/target.ts](../../src/generator/_walker/target.ts))
renders it idiomatically — React `aria-*`, Vue `:aria-*`, Svelte `aria-*`, HEEx
attributes — so a11y generalises across the whole frontend family through the
existing seam.

## Testing / CI

- **`generated-a11y.yml`** — the a11y analog of
  [`generated-react-build.yml`](../../.github/workflows): for every
  `example × pack`, generate the frontend, build it, and run **axe-core**
  (jest-axe or Playwright + `@axe-core/playwright`) against every emitted page,
  asserting **zero violations**. Because output is generated, this is
  *exhaustive* across the matrix — coverage no hand-written app achieves.
- **Per-primitive a11y unit assertions** — each primitive's emitted role/name/
  ARIA pinned alongside the existing `walker-*.test.ts` files.
- **Pack contrast check** — a token-level WCAG-AA contrast assertion per pack
  theme, run in the `lint` job.

## Phased implementation

**Phase 1 — the contract + completeness gate (≈1 week).**
Add `a11y` to `PrimitiveDef`; fill it for all 52 primitives; pin with a
completeness test. No emit change yet — the contract is data only.

**Phase 2 — React emit + derived structure (≈1.5 weeks).**
Walker emits role/name/label-association from the contract; enrich derives
heading levels; shell emits landmarks + skip link; Modal focus trap; live
regions on forms/loaders. Byte-fixture diffs gated; `LOOM_REACT_BUILD=1` smoke.

**Phase 3 — validation + author hints (≈3 days).**
`alt:` / `decorative` / `label:` slots; the four `loom.a11y-*` codes.

**Phase 4 — the axe CI gate (≈3 days).**
`generated-a11y.yml` across `example × pack`; fix the violations it surfaces in
the lead pack (Mantine) first, then backfill.

**Phase 5 — cross-framework + pack gate (≈1 week, parallelisable).**
Vue/Svelte targets honour the contract; HEEx live-region/landmark emit; the
`loom.a11y-pack-incomplete` contrast/role gate; one non-library pack (a shadcn
variant) brought to AA as the worked example.

Acceptance gate at every phase: byte-identical fixture output where applicable,
zero axe violations on the covered matrix, and the existing `LOOM_*_BUILD`
suites green.

## Open questions

1. **Decorative-by-default for `Icon`?** An `Icon` inside a labelled control is
   decorative (`aria-hidden`); a standalone `Icon` conveying meaning needs a
   name. Derive from context (inside a named control → decorative) or require
   `label:`/`decorative` explicitly? Recommend derive-from-context, with
   `loom.a11y-icon-only-no-name` as the backstop.
2. **How far into pack themes does the contrast gate reach?** Token-level AA is
   mechanical; component-state contrast (disabled, hover) is fuzzier. Start with
   token-level; revisit if axe surfaces state-contrast misses.
3. **Reduced-motion.** Emit `prefers-reduced-motion` guards around pack
   animations by default, or leave to the pack? Recommend default-emit; cheap
   and universally correct.
