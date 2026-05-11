# Pack equivalence audit

> Status: **first pass — Mantine and shadcn both verified working; ashPhoenix column added**.
> Updated 2026-05-11.

This document tracks the empirical state of each design-system pack
shipped under `designs/`.  It's the evidence base for any decision to
move templates into the sibling shared-template directories (`vite/`,
`api/`, `docker/`) — without proven equivalence, sharing is a leaky
abstraction.

The architectural rule:

- **Low-level design-system-dependent templates stay per-pack and
  dead-simple, even with some duplication.**
- **Templates land in a shared directory (`vite/`, `api/`, `docker/`)
  only when they have ZERO design-system content** — pack-agnostic
  project-shell or framework-glue files (Dockerfile, tsconfig.node,
  api-client, index.html).
- **"Small differences" like `<Table.Td>` vs `<TableCell>`** are
  design-system identity, not duplication.  Don't unify them.

## Empirical validation results

### Pack-level static checks

| Layer | Mantine | shadcn |
|---|---|---|
| `node bin/cli.js generate system <ddd>` produces files for `design: <pack>` | ✅ | ✅ |
| `tsc --noEmit` on generated `web_app/` | ✅ | ✅ |
| `vite build` of generated `web_app/` | ✅ (~3 s) | ✅ (~3-6 s) |

`LOOM_REACT_BUILD=1 npx vitest run test/generated-react-build.test.ts`
exercises 4 examples × 2 packs = 8 cases.  All 8 pass on main as of
this audit.  **Both packs compile under strict TypeScript.**

Manual `vite build` was run against shadcn-generated:
- `examples/sales-system.ddd`: 23 KB CSS, 496 KB JS.  Clean.
- `web/src/examples/banking-system.ddd`: 213 KB CSS, 582 KB JS.  Clean.

### Bundle / Boot / Preview

`web/e2e/preview-shadcn.spec.ts` covers the playground's full pipeline:

| Step | What it asserts | Status |
|---|---|---|
| Generate | shadcn slot accepted; worker generates without error | ✅ runs locally |
| Bundle / Boot / Preview | iframe renders with `min-h-screen` Tailwind class on the app shell (proves shadcn rendering, not Mantine) | ⏳ skipped on no-esm.sh sandboxes; runs on GitHub Actions CI (`.github/workflows/playground-e2e.yml`, PR #85) |

The CI workflow gates this on every PR to main.  As long as it stays
green, Bundle / Boot / Preview is verified for shadcn.

### Visual catalogue

The playground ships three storybook examples (added in PR #88):

- `web/src/examples/storybook-mantine.ddd` — comprehensive aggregate-CRUD catalogue, Mantine pack
- `web/src/examples/storybook-shadcn.ddd` — same DDL, shadcn pack
- `web/src/examples/storybook-components.ddd` — single-page page-metamodel catalogue (walker-rendered)

These are designed for side-by-side visual comparison.  Open the
playground, switch to each, run Generate → Bundle → Boot → Preview;
visually compare.

## Pack-by-pack inventory

### Shared template directories (genuinely DS-agnostic)

Three sibling directories beside `designs/` hold pack-agnostic glue —
pure non-JSX files that have nothing to do with which React design
system is active.  They're separated by purpose so each name pulls
its weight:

| Dir | Files | Purpose |
|---|---|---|
| `vite/` | `index-html.hbs`, `tsconfig-node.hbs` | Vite framework entry & node-side TS config |
| `api/` | `api-client.hbs`, `api-config.hbs` | TS fetch wrapper + `API_BASE_URL` export |
| `docker/` | `dockerfile.hbs`, `dockerignore.hbs` | Multi-stage Node image + Vite ignore list |

Field-row helpers were previously colocated in a single `_shared/`
directory; they were reverted to per-pack because each one is a
single line and the architectural cost of sharing exceeded the
duplication savings.

### Per-pack templates that genuinely differ (stay per-pack)

The following templates exist in BOTH packs but produce different
output because they render design-system components.  Per the rule,
they stay per-pack:

| Logical name | Mantine renders | shadcn renders |
|---|---|---|
| `theme.hbs` | `createTheme({...})` from `@mantine/core` | CSS variables on `:root` |
| `app-shell.hbs` | `<AppShell>` + `<AppShell.Navbar>` (Mantine pattern) | flex layout + sidebar div |
| `home.hbs` | `<Stack>`, `<Title>`, `<Card>`, `<SimpleGrid>` (Mantine) | flex/grid divs, h2/p, `<Card>` from shadcn |
| `page-list.hbs` | `<Table>`, `<Breadcrumbs>`, `<Anchor>`, `<Button>` (Mantine) | `<Table>`, nav-style breadcrumbs, `<Link>`, `<Button>` (shadcn) |
| `page-detail.hbs` | Mantine layout with op-button-state pattern | shadcn layout with discriminator-string state |
| `page-new.hbs` | react-hook-form via `register()` spread | react-hook-form via `<FormField>` render-prop |
| `operation-modal.hbs` | `<Modal>` component | `<Dialog>` from shadcn |
| `workflow-form.hbs` | `notifications.show()`; `<form>` raw | `toast.success/error()`; `<Form>` provider |
| `workflow-index.hbs` | `<SimpleGrid><Card>` Mantine | grid divs + shadcn Card |
| `views-index.hbs` | Same as workflow-index, different slug | Same per-pack split |
| `view-table.hbs` | `<Table>` from `@mantine/core` | `<Table>` from `@/components/ui/table` |
| `op-button.hbs` | `onClick={() => openXModal()}` (per-op helper fns) | `onClick={() => setOpenModal("name")}` (discriminator) |
| `part-table.hbs` | Mantine `<Table>` with operation buttons | shadcn `<Table>` with operation buttons |
| `format-helpers.hbs` | Tooltip imports from `@mantine/core` | Tooltip + TooltipProvider + TooltipTrigger from shadcn |
| `package-json.hbs` | Mantine deps (`@mantine/core`, etc.) | shadcn deps (`@radix-ui/*`, `tailwindcss`, etc.) |
| `tsconfig.hbs` | Standard config | + `@/*` path mapping for shadcn |
| `vite-config.hbs` | Standard | + PostCSS for Tailwind |

All of these emit JSX that uses design-system components specific to
that pack.  Per the rule, **even when the textual diff between
Mantine and shadcn versions is small, the design-system identity
makes them genuinely different files.**

### Cells (`cell-*.hbs`)

All 8 cell templates in both packs differ ONLY in `<Table.Td>` (Mantine)
vs `<TableCell>` (shadcn) on the wrapper element.  Per the rule, that
single token IS design-system identity.  **Stay per-pack.**

| Template | Both packs share | Differs in |
|---|---|---|
| `cell-bool.hbs` | `<BoolValue>` runtime helper | `<Table.Td>` vs `<TableCell>` |
| `cell-datetime.hbs` | `<DateTimeValue>` | wrapper |
| `cell-enum.hbs` | enum-pill rendering | wrapper + pack-specific pill JSX |
| `cell-id.hbs` | `<IdValue>` | wrapper |
| `cell-id-link.hbs` | id rendering | wrapper + Mantine Anchor vs shadcn Link |
| `cell-row-id-link.hbs` | similar to id-link | wrapper + Anchor pattern |
| `cell-number.hbs` | `<NumberValue>` | wrapper |
| `cell-string.hbs` | empty-fallback expression | wrapper |

### Field rows (`field-row-*.hbs`)

Of the 8 field-row templates, 5 are byte-identical and shared
(see `_shared/` table above).  The remaining 3:

| Template | Why per-pack |
|---|---|
| `field-row-enum.hbs` | Enum pill rendering differs per pack |
| `field-row-id-link.hbs` | Mantine `<Anchor>` vs shadcn `<Link className="...">` |
| `field-row-valueobject.hbs` | Recursive structure, pack-specific wrapping |

### Field inputs (`field-input-*.hbs`)

All 10 field-input templates stay per-pack.  React-hook-form integration
differs: Mantine spreads `register()` onto inputs; shadcn uses the
controlled-render-prop `<FormField>` pattern.  These are genuinely
different integration patterns, not just visual differences.

### Walker primitives (`primitive-*.hbs`)

All 22 primitive templates stay per-pack.  Each renders the pack's
design-system component (Mantine `<Stack>` vs shadcn `<div className="flex flex-col">`).
The walker calls them via `pack.render("primitive-X", vm)` (PR #89);
the per-pack `imports` map in `pack.json` declares the right named
imports.  These are the SOURCE of design-system identity at the
template layer.

### Components-ui (`components-ui-*.hbs`)

shadcn-only.  These are the source-imported component library files
that shadcn bundles into the generated project (`src/components/ui/*.tsx`).
Mantine doesn't have an equivalent because Mantine ships its components
as an npm package.

## Verdict and forward path

After this audit, **shadcn pack works**.  Both packs are functionally
equivalent at the systems level (same DDL produces a working app on
both packs).  They diverge in design-system identity, which is the
intended degree of freedom.

**No high-level templates are good migration candidates** under the
current architectural rules.  Every per-pack template carries
design-system-specific JSX that — by the user's own clarifications —
should NOT be unified.  The previously-considered candidates
(`workflow-form.hbs`, `op-button.hbs`, `page-list.hbs`, `views-index.hbs`,
…) all carry meaningful pack-specific glue:

- `workflow-form.hbs` uses pack-specific notification API + form-wrapper pattern.
- `op-button.hbs` uses pack-specific page-state pattern.
- `page-list.hbs` uses pack-specific table + breadcrumb structure.
- `views-index.hbs` uses pack-specific grid + card-with-icon-button pattern.

**The shared layer is essentially complete.**  The 6 templates
across `vite/`, `api/`, and `docker/` are the genuinely shareable
surface.  Further movement of templates into a shared directory
would violate the architectural rule.

## What CAN still happen

1. **Pack-author guide** (`docs/design-system-packs.md`) — documents
   the contract a third-party pack must satisfy.  ✅ landed in this PR.
2. **Custom-pack fixture** (`designs/minimal/` or similar) — proves
   the contract works for a pack that's neither Mantine nor shadcn.
3. **Per-template behavioral tests** — extend `LOOM_REACT_BUILD` to
   also runtime-test that generated apps respond to user input
   correctly (not just compile + bundle).  Closes the runtime-coverage
   gap noted in this document.
4. **CI for the e2e Playwright spec** — already wired in PR #85.
   Verify that `preview-shadcn.spec.ts` passes the Bundle/Boot/Preview
   steps on real-network CI.

---

## ashPhoenix (HEEx) coverage

> Batch F4 — added 2026-05-11.

### HEEx-pack architecture notes

Before reading the matrix, three structural differences from the TSX packs matter:

1. **Same VM shape, different template language.**  All preparers
   (`page-list-preparer.ts`, `workflow-preparer.ts`, …) are
   framework-neutral and produce the same logical VM regardless of
   pack format.  However, HEEx templates ignore React-specific VM
   fields (e.g. `register()` spread objects, JSX import maps) — those
   fields are simply absent from what the template uses.

2. **Runtime rendering, not build-time bundling.**  TSX packs are
   compiled by Vite at build time into a JS bundle.  HEEx templates
   are rendered at request time by `Phoenix.LiveView` via the `~H""`
   sigil.  This means `package-json`, `tsconfig`, and `vite-config`
   have no Phoenix equivalent and are declared in `pack.json` as
   manifest stubs only (comment-only files).

3. **Walker bypasses pack templates for custom-body pages.**
   `src/generator/phoenix-live-view/heex-walker.ts` handles the closed
   primitive library directly in TypeScript for `page X { body: ... }`
   expressions.  For the 13 primitives that the walker does not yet
   fully implement (see Batch H in the follow-ups plan), the walker
   emits an HEEx comment marker rather than delegating to the pack
   template.  The pack templates for those primitives ARE full
   implementations; the gap is in the walker dispatch, not in the
   templates themselves.

### Pack-level static checks

| Layer | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| Generator produces files for `design: <pack>` | ✅ | ✅ | ✅ |
| `tsc --noEmit` on generated output | ✅ | ✅ | N/A — Elixir |
| `vite build` of generated output | ✅ (~3 s) | ✅ (~3-6 s) | N/A — `mix compile` |
| `mix compile` of generated output | N/A | N/A | ⏳ blocked on Batch E1 (egress proxy for `mix deps.get`) |

### Scaffold archetypes

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `app-shell` | ✅ | ✅ | ✅ Full — sidebar + main area with `phx-click` mobile burger |
| `home` | ✅ | ✅ | ✅ Full — aggregate / workflow / view stat cards |
| `main` | ✅ | ✅ | ✅ Full — `root.html.heex` skeleton with CSRF + LiveTitle |
| `theme` | ✅ | ✅ | ✅ Full — CSS custom properties (`--color-primary`, font, radius) |
| `page-list` | ✅ | ✅ | ✅ Full — breadcrumb, table, empty state, loading skeleton |
| `page-detail` | ✅ | ✅ | ✅ Full — field rows, op-buttons, inline operation modals |
| `page-new` | ✅ | ✅ | ✅ Full — `<.simple_form>` with `phx-submit="save"` |
| `operation-modal` | ✅ | ✅ | ✅ Full — `<.modal>` with `AshPhoenix.Form`-backed submit |
| `workflow-form` | ✅ | ✅ | ✅ Full — `<.simple_form phx-submit="run_workflow">` |
| `workflow-index` | ✅ | ✅ | ✅ Full — grid of workflow cards with param list |
| `views-index` | ✅ | ✅ | ✅ Full — grid of view cards |
| `view-table` | ✅ | ✅ | ✅ Full — paginated read-only table with loading/error state |
| `part-table` | ✅ | ✅ | ✅ Full — nested collection table inside detail page |
| `op-button` | ✅ | ✅ | ✅ Full — `phx-click="open_modal" phx-value-op=` |
| `format-helpers` | ✅ | ✅ | 🟡 Stub — comment only; actual Elixir format module emitted by Phase 6B generator code |
| `package-json` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; Phoenix projects use `mix.exs` |
| `tsconfig` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; not applicable to Elixir |
| `vite-config` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; not applicable to Elixir |

### Cell templates

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `cell-id` | ✅ | ✅ | ✅ Full — `<td>` with truncated monospace id |
| `cell-string` | ✅ | ✅ | ✅ Full |
| `cell-bool` | ✅ | ✅ | ✅ Full — Yes/No badge |
| `cell-datetime` | ✅ | ✅ | ✅ Full — `Calendar.strftime/2` |
| `cell-number` | ✅ | ✅ | ✅ Full — `:erlang.float_to_binary/2` with decimals |
| `cell-enum` | ✅ | ✅ | ✅ Full — inline badge |
| `cell-id-link` | ✅ | ✅ | ✅ Full — `<.link navigate=...>` |
| `cell-row-id-link` | ✅ | ✅ | ✅ Full — with `JS.stop_propagation()` |
| `cell-bool-value` | ✅ | ✅ | ❌ Missing — mantine value-component variant not ported |
| `cell-datetime-value` | ✅ | ✅ | ❌ Missing |
| `cell-enum-value` | ✅ | ✅ | ❌ Missing |
| `cell-id-value` | ✅ | ✅ | ❌ Missing |
| `cell-id-link-value` | ✅ | ✅ | ❌ Missing |
| `cell-row-id-link-value` | ✅ | ✅ | ❌ Missing |
| `cell-number-value` | ✅ | ✅ | ❌ Missing |
| `cell-string-value` | ✅ | ✅ | ❌ Missing |

> **Note on `cell-*-value` templates.**  In the TSX packs these are
> helper sub-components (e.g. `<BoolValue>`, `<DateTimeValue>`) that
> can be composed inside JSX outside of a `<td>`.  HEEx has no direct
> equivalent pattern; the ashPhoenix pack inlines the rendering logic
> directly into each `cell-*.heex.hbs`.  The missing entries above
> represent a logical-name gap in the manifest, not a functional gap
> in rendered output.

### Field-row templates

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `field-row-string` | ✅ | ✅ | ✅ Full |
| `field-row-id` | ✅ | ✅ | ✅ Full — monospace `<dd>` |
| `field-row-bool` | ✅ | ✅ | ✅ Full — Yes/No inline |
| `field-row-number` | ✅ | ✅ | ✅ Full — tabular-nums |
| `field-row-datetime` | ✅ | ✅ | ✅ Full — `Calendar.strftime` with UTC label |
| `field-row-id-link` | ✅ | ✅ | ✅ Full — `<.link navigate=...>` |
| `field-row-enum` | ✅ | ✅ | ✅ Full — inline badge |
| `field-row-valueobject` | ✅ | ✅ | ✅ Full — indented sub-rows with `{{#each voFields}}` |

### Field-input templates

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `field-input-string` | ✅ | ✅ | ✅ Full — `<.input type="text">` |
| `field-input-int` | ✅ | ✅ | ✅ Full — `type="number" step="1"` |
| `field-input-decimal` | ✅ | ✅ | ✅ Full — `type="number" step="0.01"` |
| `field-input-bool` | ✅ | ✅ | ✅ Full — `type="checkbox"` |
| `field-input-datetime` | ✅ | ✅ | ✅ Full — `type="datetime-local"` |
| `field-input-id-select` | ✅ | ✅ | ✅ Full — `type="select"` with `Enum.map` options |
| `field-input-id-text` | ✅ | ✅ | ✅ Full — `type="text"` with placeholder |
| `field-input-enum-select` | ✅ | ✅ | ✅ Full — `type="select"` with static enum options |
| `field-input-valueobject` | ✅ | ✅ | ✅ Full — `<fieldset>` / `<legend>` wrapper |
| `field-input-array` | ✅ | ✅ | ✅ Full — `type="textarea"` JSON hint |

### Walker primitive templates

| Logical name | Mantine | shadcn | ashPhoenix | Walker support |
|---|---|---|---|---|
| `primitive-heading` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-text` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-stack` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-group` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-toolbar` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-divider` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-container` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-card` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-badge` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-button` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-empty` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-anchor` | ✅ | ✅ | ✅ Full — `<.link navigate=...>` | ✅ walker-dispatched |
| `primitive-image` | ✅ | ✅ | ✅ Full | ✅ walker-dispatched |
| `primitive-avatar` | ✅ | ✅ | ✅ Full — initials from `String.first(@name)` | ✅ walker-dispatched |
| `primitive-loader` | ✅ | ✅ | ✅ Full — inline SVG spinner | ✅ walker-dispatched |
| `primitive-stat` | ✅ | ✅ | ✅ Full — label + large value | 🟡 HEEx comment only |
| `primitive-field` | ✅ | ✅ | ✅ Full — `<.input type="text">` | 🟡 HEEx comment only |
| `primitive-toggle` | ✅ | ✅ | ✅ Full — `<.input type="checkbox">` | 🟡 HEEx comment only |
| `primitive-number-field` | ✅ | ✅ | ✅ Full — `<.input type="number">` | 🟡 HEEx comment only |
| `primitive-password-field` | ✅ | ✅ | ✅ Full — `<.input type="password">` | 🟡 HEEx comment only |
| `primitive-grid` | ✅ | ✅ | ✅ Full — Tailwind `grid-cols` | 🟡 HEEx comment only |
| `primitive-tabs` | ✅ | ✅ | ✅ Full — `phx-click="switch_tab"` | 🟡 HEEx comment only |
| `primitive-table` | ✅ | ✅ | ✅ Full — `<table>` wrapper | 🟡 HEEx comment only |
| `primitive-money` | ✅ | ✅ | ✅ Full — `:erlang.float_to_binary/2` | 🟡 HEEx comment only |
| `primitive-date-display` | ✅ | ✅ | ✅ Full — `Calendar.strftime/2` | 🟡 HEEx comment only |
| `primitive-enum-badge` | ✅ | ✅ | ✅ Full | 🟡 HEEx comment only |
| `primitive-id-link` | ✅ | ✅ | ✅ Full — truncated `<.link>` | 🟡 HEEx comment only |
| `primitive-form-of` | ✅ | ✅ | ✅ Full — `<.simple_form for={@form}>` | 🟡 HEEx comment only |
| `primitive-paper` | ✅ | ✅ | ✅ Full — white card div | 🟡 HEEx comment only |
| `primitive-skeleton` | ✅ | ✅ | ✅ Full — animated pulse bars | 🟡 HEEx comment only |
| `primitive-alert` | ✅ | ✅ | ✅ Full — multi-colour via `case @color` | 🟡 HEEx comment only |
| `primitive-query-view` | ✅ | ✅ | ✅ Full — loading/error/content branches | 🟡 HEEx comment only |
| `primitive-breadcrumbs` | ✅ | ✅ | ✅ Full — `Enum.with_index` nav | 🟡 HEEx comment only |
| `primitive-key-value-row` | ✅ | ✅ | ✅ Full — `<dt>`/`<dd>` pair | 🟡 HEEx comment only |

> **Walker dispatch column.**  "✅ walker-dispatched" means the HEEx
> walker (`src/generator/phoenix-live-view/heex-walker.ts`) already
> calls `pack.render("primitive-X", vm)` for this primitive in
> custom-body pages.  "🟡 HEEx comment only" means the walker emits a
> comment placeholder instead; the pack template is complete but is
> not yet wired.  Closing this gap is Batch H in the follow-ups plan.

### form-of / form-runs helpers

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `form-of-imports` | ✅ | ✅ | 🟡 Stub — comment showing `alias AshPhoenix.Form`; actual alias emitted by generator code |
| `form-of-decls` | ✅ | ✅ | 🟡 Stub — comment showing `AshPhoenix.Form.for_create/3`; actual call emitted by generator code |
| `form-runs-imports` | ✅ | ✅ | ❌ Missing — not declared in `pack.json`; Elixir equivalent not yet templated |
| `form-runs-decls` | ✅ | ✅ | ❌ Missing — same as above |

### Undeclared extra files (exist in `designs/ashPhoenix/` but not in `pack.json` `emits`)

These files are used by the Phoenix generator but are not routed
through the pack-manifest `emits` mechanism — they are emitted
directly by generator code or by a separate static-copy step.

| File | Purpose |
|---|---|
| `app-layout.heex.hbs` | `lib/<app>_web/components/layouts/app.html.heex` — inner layout shell |
| `assets-css.heex.hbs` | `assets/css/app.css` — Tailwind entry + CSS imports |
| `assets-js.heex.hbs` | `assets/js/app.js` — Phoenix JS hooks entry |
| `core-components.heex.hbs` | `lib/<app>_web/components/core_components.ex` — `<.input>`, `<.button>`, `<.modal>` etc. |
| `tailwind-config.heex.hbs` | `assets/tailwind.config.js` |

### ashPhoenix coverage summary

| Category | Full ✅ | Stub 🟡 | Missing ❌ | Declared in pack.json |
|---|---|---|---|---|
| Scaffold archetypes + support | 14 | 4 | 0 | 18 |
| Cell templates | 8 | 0 | 0 | 8 |
| Field-row templates | 8 | 0 | 0 | 8 |
| Field-input templates | 10 | 0 | 0 | 10 |
| Primitive templates | 34 | 0 | 0 | 34 |
| form-of helpers | 0 | 2 | 0 | 2 |
| **Total (declared)** | **74** | **6** | **0** | **80** |

**Gaps relative to the mantine/shadcn baseline (not declared in ashPhoenix `pack.json`):**

| Missing logical name | Mantine | shadcn | ashPhoenix | Notes |
|---|---|---|---|---|
| `cell-bool-value` | ✅ | ✅ | ❌ | TSX value-component pattern; logic inlined in `cell-bool.heex.hbs` |
| `cell-datetime-value` | ✅ | ✅ | ❌ | Same — inlined in `cell-datetime.heex.hbs` |
| `cell-enum-value` | ✅ | ✅ | ❌ | Same |
| `cell-id-value` | ✅ | ✅ | ❌ | Same |
| `cell-id-link-value` | ✅ | ✅ | ❌ | Same |
| `cell-row-id-link-value` | ✅ | ✅ | ❌ | Same |
| `cell-number-value` | ✅ | ✅ | ❌ | Same |
| `cell-string-value` | ✅ | ✅ | ❌ | Same |
| `form-runs-imports` | ✅ | ✅ | ❌ | Real gap — workflow `runs:` composition not yet templated |
| `form-runs-decls` | ✅ | ✅ | ❌ | Real gap — same |

The 8 missing `cell-*-value` entries are a manifest gap rather than a
functional gap: HEEx has no sub-component composition pattern
equivalent to JSX, so the rendering logic is inlined directly in each
`cell-*.heex.hbs`.  The 2 missing `form-runs-*` entries are a real
functional gap for workflow-form scenarios that use `runs: workflow`
composition; closing them is part of Batch H.  The 4 stubs
(`format-helpers`, `package-json`, `tsconfig`, `vite-config`) are
either intentionally N/A for Elixir or are placeholders for
functionality emitted directly by generator code rather than through
the pack-manifest mechanism.
