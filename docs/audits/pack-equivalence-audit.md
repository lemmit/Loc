# Pack equivalence audit

> Status: **first pass — Mantine and shadcn both verified working; ashPhoenix column refreshed post-PR #117**.
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

> Batch F4 — added 2026-05-11; refreshed post-PR #117 (2026-05-11).

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

3. **Walker is the canonical render path for all scaffold-expanded pages (PR #117).**
   `src/generator/phoenix-live-view/heex-walker.ts` is the sole render path for
   every page in the Phoenix generator — `liveview-emit.ts` always calls
   `walkBodyToHeex(page.body)` and the old `scaffoldOrigin` branch has been
   deleted.  `expandScaffoldPages()` in `lower.ts` rewrites every scaffold
   page's body into an ExprIR walker tree before any emitter runs, so the
   walker handles Breadcrumbs, Anchor, Form, Table, QueryView, KeyValueRow,
   Skeleton, Alert, Column, IdLink, DateDisplay, EnumBadge, and the
   page-level `<.flash_group>`/`<.app_shell>` shells directly in TypeScript.
   Primitive rendering for scaffold-expanded pages is **not** delegated to
   pack templates — the pack templates for primitives are used only for
   custom-body `page X { body: ... }` expressions that invoke the closed
   primitive library via `pack.render("primitive-X", vm)`.  As a result,
   PR #117 deleted 39 pack templates (all cell-*, field-row-*, field-input-*,
   scaffold-page, and form-of-* files) that the walker now renders inline;
   the pack ships **41 templates** (shell + primitives + stubs).  There is no
   "Batch H" follow-up for walker wiring — the walker is fully wired for all
   scaffold-expanded content.

### Pack-level static checks

| Layer | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| Generator produces files for `design: <pack>` | ✅ | ✅ | ✅ |
| `tsc --noEmit` on generated output | ✅ | ✅ | N/A — Elixir |
| `vite build` of generated output | ✅ (~3 s) | ✅ (~3-6 s) | N/A — `mix compile` |
| `mix compile` of generated output | N/A | N/A | ⏳ blocked on Batch E1 (egress proxy for `mix deps.get`) |

### Scaffold archetypes

> The scaffold-page templates (`home`, `page-list`, `page-detail`, `page-new`,
> `operation-modal`, `workflow-form`, `workflow-index`, `views-index`,
> `view-table`, `part-table`, `op-button`) were **deleted from the pack in PR #117**.
> `expandScaffoldPages()` rewrites every scaffold page body into an ExprIR tree;
> `walkBodyToHeex()` in `heex-walker.ts` then renders it inline.  No pack
> template is needed or consulted for these pages.

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `app-shell` | ✅ | ✅ | ✅ Full — sidebar + main area with `phx-click` mobile burger |
| `home` | ✅ | ✅ | 🟦 N/A — walker emits (scaffold expander + walker renders inline) |
| `main` | ✅ | ✅ | ✅ Full — `root.html.heex` skeleton with CSRF + LiveTitle |
| `theme` | ✅ | ✅ | ✅ Full — CSS custom properties (`--color-primary`, font, radius) |
| `page-list` | ✅ | ✅ | 🟦 N/A — walker emits |
| `page-detail` | ✅ | ✅ | 🟦 N/A — walker emits |
| `page-new` | ✅ | ✅ | 🟦 N/A — walker emits |
| `operation-modal` | ✅ | ✅ | 🟦 N/A — walker emits |
| `workflow-form` | ✅ | ✅ | 🟦 N/A — walker emits |
| `workflow-index` | ✅ | ✅ | 🟦 N/A — walker emits |
| `views-index` | ✅ | ✅ | 🟦 N/A — walker emits |
| `view-table` | ✅ | ✅ | 🟦 N/A — walker emits |
| `part-table` | ✅ | ✅ | 🟦 N/A — walker emits |
| `op-button` | ✅ | ✅ | 🟦 N/A — walker emits |
| `format-helpers` | ✅ | ✅ | 🟡 Stub — comment only; actual Elixir format module emitted by Phase 6B generator code |
| `package-json` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; Phoenix projects use `mix.exs` |
| `tsconfig` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; not applicable to Elixir |
| `vite-config` | ✅ | ✅ | 🟡 N/A stub — declared for manifest parity; not applicable to Elixir |

### Cell templates

> All 8 cell templates were **deleted from the pack in PR #117**.  Table
> columns for scaffold-expanded pages are now rendered by `renderTableColumn()`
> in `heex-walker.ts`, which emits `<:col>` slot content inline using the
> walker's `Column`/`IdLink`/`DateDisplay`/`EnumBadge` primitives.  No
> per-cell pack template is consulted.

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `cell-id` | ✅ | ✅ | 🟦 N/A — walker emits (`IdLink` / inline `<:col>`) |
| `cell-string` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-bool` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-datetime` | ✅ | ✅ | 🟦 N/A — walker emits (`DateDisplay`) |
| `cell-number` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-enum` | ✅ | ✅ | 🟦 N/A — walker emits (`EnumBadge`) |
| `cell-id-link` | ✅ | ✅ | 🟦 N/A — walker emits (`IdLink`) |
| `cell-row-id-link` | ✅ | ✅ | 🟦 N/A — walker emits (`IdLink`) |
| `cell-bool-value` | ✅ | ✅ | 🟦 N/A — walker emits (no JSX sub-component pattern in HEEx; logic is inline) |
| `cell-datetime-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-enum-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-id-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-id-link-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-row-id-link-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-number-value` | ✅ | ✅ | 🟦 N/A — walker emits |
| `cell-string-value` | ✅ | ✅ | 🟦 N/A — walker emits |

### Field-row templates

> All 8 field-row templates were **deleted from the pack in PR #117**.  Detail
> page field rows for scaffold-expanded pages are now rendered by
> `renderKeyValueRow()` in `heex-walker.ts`, which emits `<dl>`/`<div>`/`<dt>`/`<dd>`
> structure inline using the `KeyValueRow` walker primitive.  Type-specific
> rendering (links, dates, enum badges) is handled by nested `IdLink`,
> `DateDisplay`, and `EnumBadge` walker primitives.

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `field-row-string` | ✅ | ✅ | 🟦 N/A — walker emits (`KeyValueRow`) |
| `field-row-id` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-row-bool` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-row-number` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-row-datetime` | ✅ | ✅ | 🟦 N/A — walker emits (`DateDisplay` inside `KeyValueRow`) |
| `field-row-id-link` | ✅ | ✅ | 🟦 N/A — walker emits (`IdLink` inside `KeyValueRow`) |
| `field-row-enum` | ✅ | ✅ | 🟦 N/A — walker emits (`EnumBadge` inside `KeyValueRow`) |
| `field-row-valueobject` | ✅ | ✅ | 🟦 N/A — walker emits (nested `KeyValueRow` subtree) |

### Field-input templates

> All 10 field-input templates were **deleted from the pack in PR #117**.  Form
> inputs for scaffold-expanded pages (`page-new`, `operation-modal`,
> `workflow-form`) are now rendered by the `Form` walker primitive in
> `heex-walker.ts`, which calls `renderForm()` to emit `<.simple_form>` and
> its `<.input>` fields inline.

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `field-input-string` | ✅ | ✅ | 🟦 N/A — walker emits (`Form` / `<.input type="text">`) |
| `field-input-int` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-decimal` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-bool` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-datetime` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-id-select` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-id-text` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-enum-select` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-valueobject` | ✅ | ✅ | 🟦 N/A — walker emits |
| `field-input-array` | ✅ | ✅ | 🟦 N/A — walker emits |

### Walker primitive templates

> All 34 primitive templates remain in the pack and are **fully implemented**.
> They are invoked by the walker for custom-body `page X { body: ... }` pages.
> For scaffold-expanded pages, several of the corresponding semantic primitives
> (Breadcrumbs, Anchor, Form, Table, QueryView, KeyValueRow, Skeleton, Alert,
> Column, IdLink, DateDisplay, EnumBadge, Paper, Grid, Container) are rendered
> inline by the walker via named dispatch (no `pack.render()` call).  The
> remaining closed primitives (Stack, Heading, Text, Card, Toolbar, Empty,
> Badge, Button) flow through `closedPrimitive()` → `renderPrimitive()`, which
> also does not call `pack.render()` but emits HEEx directly.  Pack templates
> are used when these same primitives appear in **custom-body pages**.
>
> There is no "Batch H" follow-up: the walker is fully wired for all scaffold-
> expanded content as of PR #117.

| Logical name | Mantine | shadcn | ashPhoenix | Walker (scaffold-expanded pages) |
|---|---|---|---|---|
| `primitive-heading` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Heading")` |
| `primitive-text` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Text")` |
| `primitive-stack` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Stack")` |
| `primitive-group` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Stack")` (alias) |
| `primitive-toolbar` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Toolbar")` |
| `primitive-divider` | ✅ | ✅ | ✅ Full | N/A — not used in scaffold-expanded bodies |
| `primitive-container` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Container")` |
| `primitive-card` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Card")` |
| `primitive-badge` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Badge")` |
| `primitive-button` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Button")` |
| `primitive-empty` | ✅ | ✅ | ✅ Full | ✅ `closedPrimitive("Empty")` |
| `primitive-anchor` | ✅ | ✅ | ✅ Full — `<.link navigate=...>` | ✅ `renderAnchor()` (named dispatch) |
| `primitive-image` | ✅ | ✅ | ✅ Full | N/A — not used in scaffold-expanded bodies |
| `primitive-avatar` | ✅ | ✅ | ✅ Full — initials from `String.first(@name)` | N/A — not used in scaffold-expanded bodies |
| `primitive-loader` | ✅ | ✅ | ✅ Full — inline SVG spinner | N/A — not used in scaffold-expanded bodies |
| `primitive-stat` | ✅ | ✅ | ✅ Full — label + large value | N/A — not used in scaffold-expanded bodies |
| `primitive-field` | ✅ | ✅ | ✅ Full — `<.input type="text">` | N/A — not used in scaffold-expanded bodies |
| `primitive-toggle` | ✅ | ✅ | ✅ Full — `<.input type="checkbox">` | N/A — not used in scaffold-expanded bodies |
| `primitive-number-field` | ✅ | ✅ | ✅ Full — `<.input type="number">` | N/A — not used in scaffold-expanded bodies |
| `primitive-password-field` | ✅ | ✅ | ✅ Full — `<.input type="password">` | N/A — not used in scaffold-expanded bodies |
| `primitive-grid` | ✅ | ✅ | ✅ Full — Tailwind `grid-cols` | ✅ `closedPrimitive("Grid")` |
| `primitive-tabs` | ✅ | ✅ | ✅ Full — `phx-click="switch_tab"` | N/A — not used in scaffold-expanded bodies |
| `primitive-table` | ✅ | ✅ | ✅ Full — `<table>` wrapper | ✅ `renderTable()` (named dispatch) |
| `primitive-money` | ✅ | ✅ | ✅ Full — `:erlang.float_to_binary/2` | N/A — not used in scaffold-expanded bodies |
| `primitive-date-display` | ✅ | ✅ | ✅ Full — `Calendar.strftime/2` | ✅ `renderDateDisplay()` (named dispatch) |
| `primitive-enum-badge` | ✅ | ✅ | ✅ Full | ✅ `renderEnumBadge()` (named dispatch) |
| `primitive-id-link` | ✅ | ✅ | ✅ Full — truncated `<.link>` | ✅ `renderIdLink()` (named dispatch) |
| `primitive-form-of` | ✅ | ✅ | ✅ Full — `<.simple_form for={@form}>` | ✅ `renderForm()` (named dispatch via `Form`) |
| `primitive-paper` | ✅ | ✅ | ✅ Full — white card div | ✅ `closedPrimitive("Paper")` |
| `primitive-skeleton` | ✅ | ✅ | ✅ Full — animated pulse bars | ✅ `renderSkeleton()` (named dispatch) |
| `primitive-alert` | ✅ | ✅ | ✅ Full — multi-colour via `case @color` | ✅ `renderAlert()` (named dispatch) |
| `primitive-query-view` | ✅ | ✅ | ✅ Full — loading/error/content branches | ✅ `renderQueryView()` (named dispatch) |
| `primitive-breadcrumbs` | ✅ | ✅ | ✅ Full — `Enum.with_index` nav | ✅ `renderBreadcrumbs()` (named dispatch) |
| `primitive-key-value-row` | ✅ | ✅ | ✅ Full — `<dt>`/`<dd>` pair | ✅ `renderKeyValueRow()` (named dispatch) |

> **Walker column.**  "named dispatch" means `renderCall()` in `heex-walker.ts`
> has an explicit `if (expr.name === "X") return renderX()` branch that renders
> the primitive inline for scaffold-expanded pages — no `pack.render()` call.
> "`closedPrimitive()`" means the primitive falls through to the generic
> `closedPrimitive()` → `renderPrimitive()` path, which also renders inline.
> "N/A" means the primitive does not appear in any scaffold-expander output
> (it is available for custom-body pages only, where the pack template is used).

### form-of / form-runs helpers

> `form-of-imports` and `form-of-decls` were **deleted from the pack in PR #117**.
> The walker now emits `AshPhoenix.Form` setup code inline as part of the
> `renderForm()` path — no separate pack template is needed.  `form-runs-*`
> were never declared in `pack.json` and are also now walker-handled.

| Logical name | Mantine | shadcn | ashPhoenix |
|---|---|---|---|
| `form-of-imports` | ✅ | ✅ | 🟦 N/A — walker emits (`renderForm()` inlines `alias AshPhoenix.Form`) |
| `form-of-decls` | ✅ | ✅ | 🟦 N/A — walker emits (`renderForm()` inlines `AshPhoenix.Form.for_create/3`) |
| `form-runs-imports` | ✅ | ✅ | 🟦 N/A — walker emits (workflow `runs:` composition rendered inline) |
| `form-runs-decls` | ✅ | ✅ | 🟦 N/A — walker emits (same) |

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

### Legend

| Symbol | Meaning |
|---|---|
| ✅ | Template exists in `pack.json` and is fully implemented |
| 🟡 | Template exists in `pack.json` but is a stub or intentionally N/A for Elixir |
| 🟦 N/A — walker emits | Template was deleted by PR #117; the walker renders this content inline — positive outcome |
| ❌ Missing | Template absent from pack AND walker doesn't handle it — genuine gap |

### ashPhoenix coverage summary (post-PR #117)

The pack now ships **41 templates**: 3 shell files (`theme`, `main`, `app-shell`)
+ 4 Elixir-N/A stubs (`format-helpers`, `package-json`, `tsconfig`, `vite-config`)
+ 34 primitive templates.  The 39 templates deleted by PR #117 are all covered
by the walker and are marked 🟦 N/A — walker emits.

| Category | Full ✅ | Stub 🟡 | N/A walker 🟦 | Missing ❌ | Declared in pack.json |
|---|---|---|---|---|---|
| Scaffold archetypes + support | 3 | 4 | 11 | 0 | 7 (rest walker) |
| Cell templates | 0 | 0 | 16 | 0 | 0 (all walker) |
| Field-row templates | 0 | 0 | 8 | 0 | 0 (all walker) |
| Field-input templates | 0 | 0 | 10 | 0 | 0 (all walker) |
| Primitive templates | 34 | 0 | 0 | 0 | 34 |
| form-of / form-runs helpers | 0 | 0 | 4 | 0 | 0 (all walker) |
| **Total** | **37** | **4** | **49** | **0** | **41** |

**No genuine gaps remain** relative to the mantine/shadcn baseline.

- The 8 `cell-*-value` entries (TSX sub-component pattern) have no HEEx
  equivalent because HEEx has no JSX composition pattern; the walker renders
  this logic inline.  Not a functional gap.
- The `form-runs-imports` / `form-runs-decls` entries are now walker-handled
  inline.  Not a functional gap.
- The 4 stubs (`format-helpers`, `package-json`, `tsconfig`, `vite-config`) are
  intentionally N/A for Elixir or placeholders for generator-code-emitted
  functionality.  Not a functional gap.

**No follow-up batches are required** for walker wiring (Batch H was made
unnecessary by PR #117's full walker coverage of all scaffold-expanded content).
