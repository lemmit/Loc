# Design-system packs — author's guide

> Status: contract is stable.  Four `tsx`-format packs (Mantine,
> shadcn, MUI, Chakra) and one `heex`-format pack (ashPhoenix) ship
> in-tree.  Mantine and shadcn are the reference implementations for
> the npm-package and source-copy distribution models respectively.

A **design-system pack** is the unit of pluggable UI in Loom's React
generator.  When a user writes `design: <name>` in a `.ddd` source's
`deployable webApp { ... }` block, the React generator loads that
pack and renders every UI surface (pages, forms, tables, cells) through
it.  Built-in packs are `mantine`, `shadcn`, `mui`, `chakra`, and
`ashPhoenix`; custom packs are any directory the user points the slot at.

This document is the contract.  If you're writing another design pack
— for Ant Design, Radix Primitives, your in-house system, whatever —
this is what you must satisfy.

## 1. Repository layout

The generator sees three categories of template directories at the
repo root:

```
designs/{mantine,shadcn,...}/    # one directory per design pack
vite/                            # pack-agnostic Vite scaffold (shared)
api/                             # pack-agnostic API integration (shared)
docker/                          # pack-agnostic deployment artifacts (shared)
```

A pack is a single directory under `designs/` (or anywhere on disk for
user packs) containing one `pack.json` manifest plus one `.hbs` file
per logical name in the manifest's `emits` map.

The three sibling directories (`vite/`, `api/`, `docker/`) supply
templates the pack inherits for free — see §6.

## 2. The `pack.json` manifest

```json
{
  "name": "mantine",
  "version": "0.1.0",
  "format": "tsx",
  "emits": { "<logical-name>": "<file-name.hbs>", ... },
  "imports": { "<logical-name>": [{ "from": "...", "named": [...] }], ... },
  "shellFiles": { "<logical-name>": "<output-path>" },
  "shellGlobs": { "<glob>": "<output-pattern>" },
  "helpers": { "lucide": { "IconPlus": "Plus", ... } }
}
```

### `format`

Optional, defaults to `"tsx"`.  Discriminates the output language the
pack's templates produce — `"tsx"` for React/Mantine/shadcn-style packs
(Handlebars over `.hbs` files yielding TSX); `"heex"` for Phoenix
LiveView packs (Handlebars over `.heex.hbs` files yielding HEEx, e.g.
the built-in `ashPhoenix` pack).

The Handlebars compiler is content-agnostic, so `format` does not
change template compilation.  It DOES gate which repo-root shared
template directories the loader pulls in:

| Format | Shared dirs read |
|---|---|
| `tsx` (default) | `vite/`, `api/`, `docker/` |
| `heex` | `phoenix/` (the in-tree `ashPhoenix` pack ships most shell content as regular `emits`; `phoenix/` is reserved for pack-agnostic Phoenix scaffolding shared across future LiveView packs) |

A pack's filename convention should match its format (`*.hbs` for tsx,
`*.heex.hbs` for heex), but the loader keys off the manifest's
`emits` paths verbatim — this is convention, not enforcement.

### `name`, `version`
Display strings.  The generator does not use `name` for resolution
(directory name + DSL slot value drive that); it surfaces in error
messages.

### `emits` — required
Map of logical template name → filename, relative to the pack
directory.  Every logical name the generator needs MUST appear here.
The loader throws on missing entries; it does not silently fall back.
See §3 for the full list of required logical names.

### `imports` — optional
Per-primitive map declaring what the generated code must import to use
that primitive.  Used by the body-walker: when the page metamodel
references a `stack`, the walker calls `primitive-stack` and looks up
this map to know which package the named exports come from.

```jsonc
"imports": {
  "primitive-button": [{ "from": "@/components/ui/button", "named": ["Button"] }],
  "primitive-card":   [{ "from": "@/components/ui/card",   "named": ["Card", "CardContent", "CardHeader", "CardTitle"] }]
}
```

Mantine maps almost every primitive to `@mantine/core`; MUI maps them
to `@mui/material`; Chakra maps them to `@chakra-ui/react`; shadcn
maps them to local `@/components/ui/*` paths (because shadcn ships
components as source — see `shellGlobs`).

Each entry in `named` is either a bare symbol (`"Button"`, emitted as
`import { Button } from ...`) or an aliased pair
(`{ "name": "Link", "as": "PackLink" }`, emitted as
`import { Link as PackLink } from ...`).  Aliasing lets a pack
disambiguate a primitive's component from another import the walker
adds elsewhere — for example, when both the pack's library and
`react-router-dom` export a `Link`.

### `shellFiles` — optional
Pack-specific files emitted as part of the project shell, declared by
logical name → output path.  Used for one-off files like
`tailwind.config.ts` or `postcss.config.js` that a pack needs but
aren't a regular template emission.

```json
"shellFiles": {
  "tailwind-config": "tailwind.config.ts",
  "postcss-config":  "postcss.config.js",
  "globals-css":     "src/globals.css",
  "lib-utils":       "src/lib/utils.ts"
}
```

### `shellGlobs` — optional
Glob-pattern → output-pattern map for emitting multiple files of the
same kind.  shadcn uses this to copy its 14 `components-ui-*.hbs`
templates to `src/components/ui/<name>.tsx`:

```json
"shellGlobs": {
  "components-ui-*": "src/components/ui/{1}.tsx"
}
```

The `{1}` substitution is the capture from the `*` in the input glob.
Mantine doesn't use this because its components come from an npm
package, not source files.

### `helpers` — optional
Pack-specific lookup tables consulted by generator-side code (not by
templates directly).  Registered helpers today:

- `lucide` (shadcn) — Tabler-icon-name → Lucide-icon-name (e.g.
  `IconPlus` → `Plus`).
- `muiIcon` (MUI) — Tabler-icon-name → `@mui/icons-material` name
  (e.g. `IconPlus` → `Add`).
- `muiRadius` / `chakraRadius` — Mantine-style radius tokens
  (`xs`/`sm`/`md`/`lg`/`xl`) → pack-native numeric or CSS value.

See §7 for what each helper unlocks.  A pack only needs the helpers
its templates actually consult.

## 3. Required emits

The generator dispatches ~80 logical names per `tsx` pack and ~40 per
`heex` pack.  Every pack must emit a file for each name the generator
calls; missing entries throw at template-resolution time, not silently.
Logical names are conceptual contracts; the `.hbs` file behind each
can render whatever the design system needs to fulfill the contract.

### Project shell (3)

| Name | Purpose |
|---|---|
| `theme` | TS module exporting the design system's theme tokens.  May be a stub if the pack handles theming elsewhere (e.g. shadcn projects tokens into `globals.css`). |
| `main` | App entrypoint.  Mounts React, sets up the router, wraps `<App>` in pack-specific providers (e.g. `<MantineProvider>` or `<Toaster>`). |
| `package-json` | `package.json` for the generated app.  Declares pack-specific dependencies. |
| `tsconfig` | `tsconfig.json`.  shadcn adds path mappings for `@/*`. |
| `vite-config` | `vite.config.ts`.  shadcn adds Vite resolver alias for `@/*`. |
| `format-helpers` | Per-pack runtime helpers (`IdValue`, `DateTimeValue`, `BoolValue`, `NumberValue`, `EmptyValue`, `KeyValueRow`).  Output written to `src/lib/format.tsx`. |
| `app-shell` | App-shell layout: navbar/sidebar/main outlet. |
| `home` | Home/dashboard page. |

### Page templates (4)

| Name | Purpose |
|---|---|
| `page-list` | Aggregate list page: header + create button + table + empty/error/loading states. |
| `page-detail` | Aggregate detail page: header + breadcrumbs + identity block + parts/operations. |
| `page-new` | Aggregate creation page.  Today emits an RHF + zodResolver scaffold (see §9.6 — RHF is the current cross-pack form-state baseline). |
| `operation-modal` | Modal/dialog rendering for aggregate operations. |

### Workflow + view templates (4)

| Name | Purpose |
|---|---|
| `workflow-form` | One workflow's form page. |
| `workflow-index` | All-workflows index page. |
| `views-index` | All-views index page. |
| `view-table` | One view's tabular page. |

### Field-input templates (10)

One per primitive type the DSL can declare as an input on a creation
or workflow form.

| Name | DSL type |
|---|---|
| `field-input-string` | string |
| `field-input-int` | int |
| `field-input-decimal` | decimal |
| `field-input-bool` | bool |
| `field-input-datetime` | datetime |
| `field-input-id-select` | id (from a known aggregate, dropdown) |
| `field-input-id-text` | id (raw text input fallback) |
| `field-input-enum-select` | enum |
| `field-input-valueobject` | value object (recursive) |
| `field-input-array` | array of any of the above |

### Field-row templates (8)

Field-rows render an aggregate's fields on the detail page.  Each
wraps `<KeyValueRow>` from `format-helpers`.

| Name | DSL kind |
|---|---|
| `field-row-string` | string |
| `field-row-id` | id |
| `field-row-id-link` | id with aggregate link |
| `field-row-datetime` | datetime |
| `field-row-bool` | bool |
| `field-row-number` | int / decimal |
| `field-row-enum` | enum |
| `field-row-valueobject` | value object (recursive) |

### Cell templates (16)

Cells render an aggregate's columns on the list page and view tables.
Each kind has two variants: the `cell-X` template wraps the pack's
`<TableCell>`-equivalent (used on list-page tables) and the
`cell-X-value` template emits just the inner value (used inside
already-cell-wrapped contexts like `primitive-table` view-tables).

| Wrapped (`cell-X`) | Inner (`cell-X-value`) | DSL kind |
|---|---|---|
| `cell-string` | `cell-string-value` | string |
| `cell-id` | `cell-id-value` | id |
| `cell-id-link` | `cell-id-link-value` | id with link |
| `cell-row-id-link` | `cell-row-id-link-value` | row-level id link |
| `cell-datetime` | `cell-datetime-value` | datetime |
| `cell-bool` | `cell-bool-value` | bool |
| `cell-number` | `cell-number-value` | int / decimal |
| `cell-enum` | `cell-enum-value` | enum |

### Form-helper templates (5)

`Form(of: <Agg>)` and `Form(runs: <wf>)` page bodies dispatch to these
per-pack snippets for the imports/declarations/submit-flow that vary
between an aggregate-create form and a workflow-run form, plus the
default submit handler.

| Name | Purpose |
|---|---|
| `form-of-imports` | Extra imports for an aggregate `Form(of:)` page (e.g. notify helpers, navigate hook). |
| `form-of-decls` | Top-of-component declarations for the same (mutation hook, navigate). |
| `form-runs-imports` | Extra imports for a workflow `Form(runs:)` page. |
| `form-runs-decls` | Top-of-component declarations for the same (workflow mutation hook). |
| `form-default-onsubmit` | The submit-handler body when no explicit `onSubmit:` lambda is given on the `Form` node: mutation call → notify → navigate.  Each pack writes this with its native notification API. |

### Aggregate piece templates (2)

| Name | Purpose |
|---|---|
| `part-table` | Table rendering aggregate "parts" (collection-of-X on the detail page). |
| `op-button` | A single operation-trigger button on the detail page. |

### Walker primitives (34)

The body-walker dispatches every page-metamodel node through these
primitives.  The walker calls `pack.render("primitive-X", vm)` and
expects the pack's template to produce design-system-appropriate JSX.

**Layout / structure**

| Primitive | Use |
|---|---|
| `primitive-stack` | Vertical flex container |
| `primitive-group` | Horizontal flex container |
| `primitive-toolbar` | Horizontal toolbar (group variant) |
| `primitive-grid` | Grid container |
| `primitive-container` | Width-constrained container |
| `primitive-divider` | Visual separator |
| `primitive-paper` | Filled / outlined surface wrapper |
| `primitive-card` | Card with title + content |
| `primitive-breadcrumbs` | Breadcrumb trail |
| `primitive-tabs` | Tabs container with header + content slots |

**Content**

| Primitive | Use |
|---|---|
| `primitive-heading` | Section heading |
| `primitive-text` | Body text |
| `primitive-anchor` | Link / `<a>` |
| `primitive-image` | `<img>` wrapper |
| `primitive-avatar` | User-avatar component |
| `primitive-stat` | Stat block (label + value) |
| `primitive-badge` | Status pill / chip |
| `primitive-enum-badge` | Pack-mapped semantic-color badge for enum values |
| `primitive-money` | Currency value (delegates to `MoneyValue` helper) |
| `primitive-date-display` | Date/time value (delegates to `DateTimeValue` helper) |
| `primitive-id-link` | Linked aggregate ID (delegates to `IdValue` helper) |
| `primitive-key-value-row` | One label/value pair in a key-value list |

**Form inputs (host-level wrappers; per-field rendering lives in `field-input-*`)**

| Primitive | Use |
|---|---|
| `primitive-field` | Labeled text input |
| `primitive-toggle` | Labeled switch / checkbox |
| `primitive-number-field` | Labeled number input |
| `primitive-password-field` | Labeled password input |
| `primitive-form-of` | Outer `<form>` wrapper + submit button used by both `Form(of:)` and `Form(runs:)` page bodies; receives `submitPendingExpr` / `submitLabel` for the variant. |

**Feedback / status**

| Primitive | Use |
|---|---|
| `primitive-empty` | Empty-state message |
| `primitive-loader` | Loading spinner |
| `primitive-skeleton` | Skeleton placeholder for loading rows |
| `primitive-alert` | Inline alert with optional title + semantic color |
| `primitive-query-view` | `useQuery`-aware wrapper: renders skeleton / alert / children based on hook state |

**Other**

| Primitive | Use |
|---|---|
| `primitive-button` | Action button |
| `primitive-table` | Full table (used by `view-table` rendering of declarative views) |

## 4. Inherited shared sources

A pack does NOT need to emit these — the generator pulls them from
the repo-root sibling directories:

| Source dir | Logical name → output path |
|---|---|
| `vite/` | `index-html` → `index.html` |
|         | `tsconfig-node` → `tsconfig.node.json` |
| `api/`  | `api-client` → `src/api/client.ts` |
|         | `api-config` → `src/api/config.ts` |
| `docker/` | `dockerfile` → `Dockerfile` |
|           | `dockerignore` → `.dockerignore` |

A pack CAN override any of these by emitting a template with the same
logical name — the loader registers shared partials first, then pack
templates, so pack entries win on collision.  Don't override unless
you have a real reason (e.g. a pack that needs to be deployed as a
Cloudflare Worker instead of a Docker image could replace
`dockerfile` with a `wrangler-config` of its own).

## 5. Template language

Templates are Handlebars 4 (`handlebars` npm package).  The generator
registers these helpers globally:

- `expr <value>` — emits the value as a raw expression (no HTML
  escaping).  Use for JS expressions that should render as-is, e.g.
  `value={{expr valueExpr}}`.
- `json <value>` — JSON-stringifies the value.  Use for inline
  literals: `defaultRadius={{json radius}}`.
- Standard Handlebars: `{{#each}}`, `{{#if}}`, `{{#unless}}`,
  `{{> partial-name}}`, etc.

Every template registered via `emits` is ALSO registered as a
Handlebars partial under its logical name.  This lets higher-level
templates compose primitives:

```hbs
<form>
  {{> primitive-button label="Save"}}
  {{> primitive-button label="Cancel"}}
</form>
```

The partial dispatch resolves to whichever pack is currently loaded —
the same shared template produces Mantine output under one pack and
shadcn output under another.

`strict: true` is on.  Templates throw at render time if a referenced
field is missing from the view-model.  This is intentional: it forces
the pack and the preparer to stay in sync; missing data surfaces
immediately during tests instead of leaking blanks into output.

## 6. Distribution model: npm vs source-copy

The two reference packs illustrate the two distribution models a pack
can use:

### npm-package model (Mantine)

Components come from an npm dependency.  Each primitive's `imports`
entry points to `@mantine/core` (or similar); `package-json` declares
those packages; the generated app `npm install`s them at boot.

Pros: no source files to ship; component updates flow via package
updates; clean.

Cons: bound to the package's design decisions; pack can't customize a
single component without forking the package.

### Source-copy model (shadcn)

Components are TS files vendored into the generated project.  Each
component-ui template (`components-ui-button.hbs`,
`components-ui-table.hbs`, …) renders the source of one component;
`shellGlobs` emits each one to `src/components/ui/<name>.tsx`;
`imports` for each primitive points at the local path
(`@/components/ui/<name>`).

Pros: full ownership of every component; user can edit them after
generation.

Cons: more templates to maintain; component "updates" mean editing
your pack templates.

A custom pack can use either model or a mix.  The contract is the
same: every required logical name renders something that satisfies
the preparer's view-model.

## 7. Helpers (special-purpose maps)

The `helpers` field carries pack-specific lookup tables consulted by
generator-side code, not by templates directly.

### `lucide` (shadcn)

shadcn's icon library is `lucide-react`.  The DSL uses Tabler-style
icon names (`IconPlus`, `IconTrash`, …).  When the React generator
emits an icon reference, it looks up `helpers.lucide[<DSL name>]`
and substitutes the Lucide equivalent if present:

```json
"helpers": {
  "lucide": {
    "IconPlus": "Plus",
    "IconTrash": "Trash2",
    "IconCheck": "Check"
  }
}
```

Mantine doesn't need this — `@tabler/icons-react` exports the
DSL names directly.

### `muiIcon` (MUI)

Material UI's icon library is `@mui/icons-material`.  The MUI pack
declares the same DSL-name → MUI-name map shape:

```json
"helpers": {
  "muiIcon": {
    "IconPlus":  "Add",
    "IconTrash": "Delete",
    "IconX":     "Close"
  }
}
```

Chakra reuses Lucide (and so inherits the same icon-name story as a
plain `lucide-react` consumer); ashPhoenix uses Heroicons via Phoenix
helpers and doesn't go through this table.

### `muiRadius` / `chakraRadius`

Mantine uses string radius tokens (`xs`/`sm`/`md`/`lg`/`xl`) on
`<Card radius="md">` etc.  MUI takes raw numbers (interpreted in `px`)
on its `borderRadius` system, and Chakra takes CSS strings.  The
radius helpers translate the DSL's Mantine-shaped tokens to each
pack's native form so primitive templates can write
`{{packRadius radius}}` once instead of branching everywhere:

```json
"helpers": {
  "muiRadius":    { "xs": "2", "sm": "4", "md": "8", ... },
  "chakraRadius": { "xs": "2px", "sm": "4px", "md": "8px", ... }
}
```

shadcn doesn't need a radius helper — `<Card>` ships with Tailwind
classes baked into its source-copied component.

## 8. Validating your pack

After authoring, run the following:

### Generate and tsc-compile

```sh
node bin/cli.js generate system <your.ddd> -o /tmp/test-out
cd /tmp/test-out/web_app
npm install
npx tsc --noEmit
```

Generation must succeed; tsc must report zero errors.  If templates
reference an undeclared field, tsc will catch the resulting type
error.

### Vite build

```sh
npm run build
```

This catches issues that survive `tsc --noEmit` but break bundling:
missing CSS imports, asset resolution, Tailwind config errors.

### The `LOOM_REACT_BUILD=1` gate

The repo ships `test/generated-react-build.test.ts` which does the
above for four example systems × four built-in `tsx` packs (16 cases
total).  Add your custom pack to its cases for ongoing coverage:

```sh
LOOM_REACT_BUILD=1 npx vitest run test/generated-react-build.test.ts
```

Under parallel test execution the 16 cases can flake on shared host
resources (npm install collisions, port conflicts).  Run with
`--no-file-parallelism` for a deterministic pass when investigating
a failure.

### Side-by-side visual check

The playground ships three storybook examples (`storybook-mantine.ddd`,
`storybook-shadcn.ddd`, `storybook-components.ddd`).  Generate yours
against the storybook examples and visually compare against Mantine
and shadcn output for the same DDL.

## 9. Architectural rules

These rules constrain pack authorship and the shared-template layer
both.  See `docs/pack-equivalence-audit.md` for the empirical evidence
behind them.

1. **Low-level design-system-dependent templates stay per-pack and
   dead-simple, even with some duplication.**  Two packs both
   rendering `<Badge>{{label}}</Badge>` are not duplicating — the
   `<Badge>` resolves to different imports in each pack, so the
   shape-match is coincidental.

2. **Templates land in a shared directory (`vite/`, `api/`, `docker/`)
   only when they have ZERO design-system content.**  Pure project
   scaffold (Dockerfile, index.html, fetch wrapper) is shareable;
   anything that references a design-system component is not.

3. **"Small differences" like `<Table.Td>` vs `<TableCell>` are
   design-system identity, not duplication.**  Don't try to unify
   them.

4. **One pack, one distribution model.  But the contract is the
   same.**  The generator doesn't care whether your components come
   from npm or from vendored source; it cares whether each logical
   name renders correctly.

5. **Idiomatic per pack is the default; cross-pack baselines are
   exceptions that must be named.**  When a pack ships a load-bearing
   idiom (MUI's `<DataGrid>`, Mantine's `mantine-datatable`, AntD's
   `<Form>`), the pack should use it — code emitted under
   `design: mui` should read the way an MUI developer would write
   it.  The generator only imposes a cross-pack solution when the
   alternative is N divergent implementations of one feature with no
   per-pack value (e.g. form state — see rule 6).

6. **react-hook-form is the current cross-pack form-state baseline,
   pending a per-pack form-state seam.**  All in-tree packs emit
   `useForm` + `Controller` + `zodResolver` because the body-walker
   hardcodes this shape today.  The choice was deliberate (RHF +
   Zod is well-supported across Mantine, MUI, Chakra, and shadcn,
   and gives one validation story for all four), but it IS a
   cross-pack imposition — a future pack whose native form idiom is
   load-bearing (e.g. AntD's `<Form>`) needs a walker seam to opt
   into its own form-state strategy.  See
   `docs/antd-pack-plan.md` §5 for the deferred design.  Until that
   seam exists, every pack's `form-of-*` templates and `page-new`
   render an RHF-shaped tree.

7. **DataTable strategy is per pack, not cross-pack.**  Unlike form
   state, no cross-pack baseline applies — the four in-tree packs
   already diverge: Mantine uses (or will use) `mantine-datatable`,
   MUI uses `@mui/x-data-grid`, shadcn + Chakra use TanStack Table
   headless on top of their own `<Table>` primitive.  When a pack
   gains a richer table (sort/filter/pagination), it picks the
   library its community considers canonical — `primitive-table.hbs`
   may render very different shapes per pack.

## 10. How a user picks your pack

In a `.ddd` file:

```
deployable webApp {
  platform: react
  design: ./path/to/your-pack    // relative to the .ddd file
  port: 3001
}
```

Or by absolute path:

```
design: /opt/loom-packs/your-pack
```

Or by built-in name:

```
design: mantine     // npm-package model, the reference
design: shadcn      // source-copy model, Tailwind + Radix Primitives
design: mui         // npm-package model, @mui/material
design: chakra      // npm-package model, @chakra-ui/react
design: ashPhoenix  // heex format, Phoenix LiveView + Ash domain
```

The loader walks up from each .ddd file's location to anchor relative
paths; built-in names short-circuit and resolve under the repo's
`designs/` directory.

## 11. Worked example — minimal pack skeleton

A truly minimal pack that just delegates everything to plain HTML
elements (no design system):

```
my-pack/
  pack.json
  theme.hbs                       # empty export
  main.hbs                        # plain React boot
  app-shell.hbs                   # <div>{children}</div>
  home.hbs
  ...
  primitive-button.hbs            # <button>{{label}}</button>
  primitive-card.hbs              # <div className="card">...
  ...
```

```json
{
  "name": "minimal",
  "version": "0.0.1",
  "emits": { "theme": "theme.hbs", "main": "main.hbs", ... }
}
```

No `imports` map needed — every primitive uses plain HTML elements,
no external components to import.  No `shellFiles` / `shellGlobs` /
`helpers`.

This would still produce a working app: ugly, but type-correct, and
the contract is satisfied.

## 12. References

- `docs/pack-equivalence-audit.md` — what's shared vs per-pack, with
  evidence
- `src/generator/react/templating/loader.ts` — pure compile core
- `src/generator/react/templating/loader-fs.ts` — Node FS adapter
- `web/src/build/loader-vfs.ts` — playground VFS adapter
- `designs/mantine/`, `designs/shadcn/`, `designs/mui/`,
  `designs/chakra/`, `designs/ashPhoenix/` — in-tree packs
- `docs/antd-pack-plan.md` — deferred plan for an Ant Design pack
- `test/generated-react-build.test.ts` — the static-validation gate
- `test/pack-manifest.test.ts` — manifest-shape contract tests
- `test/template-shared-layer.test.ts` — shared-source contract tests
