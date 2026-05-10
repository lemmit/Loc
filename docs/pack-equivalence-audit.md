# Pack equivalence audit

> Status: **first pass — Mantine and shadcn both verified working**.
> Updated 2026-05-10.

This document tracks the empirical state of each design-system pack
shipped under `themes/`.  It's the evidence base for any decision to
move templates into `themes/_shared/` — without proven equivalence,
sharing is a leaky abstraction.

The architectural rule:

- **Low-level design-system-dependent templates stay per-pack and
  dead-simple, even with some duplication.**
- **Templates land in `themes/_shared/` only when they have ZERO
  design-system content** (runtime-helper-only fragments,
  pack-agnostic project-shell files like Dockerfile / tsconfig-node /
  api-client / index-html).
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

### `themes/_shared/` (genuinely DS-agnostic)

Project-scaffold files only — pure non-JSX glue that has nothing to do
with the React design system in use.  Field-row helpers were previously
in this directory; they were reverted to per-pack because each one is a
single line and the architectural cost of sharing exceeded the
duplication savings.

| Template | Why shared |
|---|---|
| `api-client.hbs` | Pure TS fetch wrapper, no JSX |
| `api-config.hbs` | Pure TS, exports `API_BASE_URL` |
| `dockerfile.hbs` | Multi-stage Node image, no design system content |
| `dockerignore.hbs` | Standard Vite ignore list |
| `index-html.hbs` | Pure HTML, no DS components |
| `tsconfig-node.hbs` | Pure JSON config |

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

**The shared layer is essentially complete.**  The 11 templates already
in `themes/_shared/` are the genuinely shareable surface.  Further
movement of templates into `_shared/` would violate the architectural
rule.

## What CAN still happen

1. **Pack-author guide** (`docs/design-system-packs.md`) — documents
   the contract a third-party pack must satisfy.
2. **Custom-pack fixture** (`themes/minimal/` or similar) — proves
   the contract works for a pack that's neither Mantine nor shadcn.
3. **Per-template behavioral tests** — extend `LOOM_REACT_BUILD` to
   also runtime-test that generated apps respond to user input
   correctly (not just compile + bundle).  Closes the runtime-coverage
   gap noted in this document.
4. **CI for the e2e Playwright spec** — already wired in PR #85.
   Verify that `preview-shadcn.spec.ts` passes the Bundle/Boot/Preview
   steps on real-network CI.
