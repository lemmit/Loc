# Design-system packs — author's guide

> Status: contract documented; Mantine and shadcn are the reference
> implementations.

A **design-system pack** is the unit of pluggable UI in Loom's frontend
generators — pluggable across React, Vue, Svelte, Angular, and Phoenix
HEEx.  When a user writes `design: <name>` in a `.ddd` source's
`deployable webApp { ... }` block, the React generator loads that
pack and renders every UI surface (pages, forms, tables, cells) through
it.  Built-in packs are `mantine`, `shadcn`, `mui`, `chakra` (React),
`vuetify`, `shadcnVue` (Vue), `shadcnSvelte`, `flowbite` (Svelte),
`angularMaterial` (Angular), and `ashPhoenix` (HEEx); custom packs are
any directory the user points the slot at.

This document is the contract.  If you're writing a third design pack
— for Material UI, Chakra, your in-house system, whatever — this is
what you must satisfy.

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
  "version": "v9",
  "format": "tsx",
  "stack": "v3",
  "emits": { "<logical-name>": "<file-name.hbs>", ... },
  "imports": { "<logical-name>": [{ "from": "...", "named": [...] }], ... },
  "shellFiles": { "<logical-name>": "<output-path>" },
  "shellGlobs": { "<glob>": "<output-pattern>" },
  "helpers": { "lucide": { "IconPlus": "Plus", ... } }
}
```

A pack manifest declares **what to emit** (`emits`, `shellFiles`,
`shellGlobs`), **what to import** in the emitted code (`imports`,
`helpers`), and **which cross-cutting stack** to ride (`stack`).  The
stack carries React / router / Zod / Vite versions; see [§ 2a Stacks
and how a pack picks one](#2a-stacks-and-how-a-pack-picks-one) below.

### `format`

Optional, defaults to `"tsx"`.  Discriminates the output language the
pack's templates produce — `"tsx"` for React/Mantine/shadcn-style packs
(Handlebars over `.hbs` files yielding TSX); `"heex"` for Phoenix
LiveView packs (Handlebars over `.heex.hbs` files yielding HEEx, e.g.
the built-in `ashPhoenix` pack); `"svelte"` for Svelte 5 / SvelteKit
packs (Handlebars over `.hbs` files yielding Svelte markup, e.g. the
built-in `shadcnSvelte` and `flowbite` packs — these declare the
`sv1` stack and own the full TSX-style required surface incl. forms
and field inputs, plus a `svelte-config` shell template).
the built-in `ashPhoenix` pack); `"vue"` for Vue 3 packs (Handlebars
yielding Vue SFC template markup, e.g. the built-in `vuetify` and
`shadcnVue` packs).

**Vue-pack authoring note — the mustache collision:** Handlebars and
Vue both use `{{ … }}`.  Generation-time VM substitutions stay plain
Handlebars (`{{label}}`, `{{{onClick}}}`); a literal Vue runtime
interpolation must be written `\{{ … }}` (Handlebars emits the
literal mustache).  JS-splicing attributes use single quotes
(`@click='{{{onClick}}}'`) because rendered JS carries double-quoted
string literals.  Vue packs additionally own the `op-dialog` template
(the operation-modal wrapper the page shell renders) — see
`REQUIRED_PRIMITIVES.vue`.

`"angular"` is the format for standalone Angular packs (Handlebars over
`.hbs` files yielding Angular component markup, e.g. the built-in
`angularMaterial` pack — it declares the `ng1` stack and emits an
`angular-json` shell instead of the Vite world's `vite-config`).  Angular's
**forms render inline through the walker** (the `renderCreateForm` /
`renderModal` seams emit typed Reactive Forms directly, not pack templates),
so an angular pack owns the **display / layout / input surface only** — it
ships **no** `form-of` / `field-input-*` / `form-*` / `op-dialog` / `modal`
templates (see `REQUIRED_PRIMITIVES.angular`, the one frontend required-set
that subtracts the form family).  Like Vue, JS-splicing event bindings use
single quotes (`(click)='{{{onClick}}}'`).

The Handlebars compiler is content-agnostic, so `format` does not
change template compilation.  It DOES gate which repo-root shared
template directories the loader pulls in:

| Format | Shared dirs read |
|---|---|
| `tsx` (default) | `vite/`, `api/`, `docker/` |
| `heex` | `phoenix/` (future; empty in v0 — `ashPhoenix` ships its shell files directly) |
| `svelte` | `sveltekit/` (api client + logger + root layout + the SvelteKit dockerfile) |
| `vue` | `vue/`, `api/`, `docker/` (the `api/` fetch-client layer is framework-neutral TS) |

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

Mantine maps almost every primitive to `@mantine/core`; shadcn maps
them to local `@/components/ui/*` paths (because shadcn ships
components as source — see `shellGlobs`).

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
Pack-specific lookup tables consulted by helpers in templates.  Today
the only registered helper is `lucide`, used by the shadcn pack to
translate Tabler-style icon names from the DSL (`IconPlus`) to
Lucide's names (`Plus`).

### `stack` — required for `tsx` packs

Identifier of the **stack** the pack rides — a coherent React +
router + Zod + Vite + TypeScript dep bundle shipped under
`stacks/<id>/` at the repo root.  This separates *what UI library you
use* (the pack) from *what underlying runtime you build against*
(the stack).  See [§ 2a](#2a-stacks-and-how-a-pack-picks-one).

## 2a. Stacks and how a pack picks one

Multiple pack families (mantine / shadcn / mui / chakra) all run on
React.  Rather than each pack restating its React / router / Zod /
Vite versions independently — which used to drift and cause
upgrade pain — the project ships a small set of **stacks** under
`stacks/<id>/` and every pack declares which one it rides.

| Stack | React | Router | Zod | TypeScript | Vite | Used by |
|---|---|---|---|---|---|---|
| `v1` | 18 | `react-router-dom@^6` | 3 | 6 | 8 | pin-only older React packs: `chakra@v2`, `mantine@v7`, `mui@v5`, `shadcn@v3` |
| `v3` | 19.2 | `react-router@^7` | 4 | 6 | 8 | the bareword-default React packs: `chakra@v3`, `mantine@v9`, `mui@v7`, `shadcn@v4` |
| `sv1` | (Svelte 5 / SvelteKit) | SvelteKit routing | 4 | 6 | 8 | the svelte packs (`shadcnSvelte`, `flowbite`) |
| `vue1` | (Vue 3) | vue-router | 4 | 6 | 8 | the vue packs (`vuetify`, `shadcnVue`) |
| `ng1` | (Angular 22) | `@angular/router` | 4 | 6 | (Angular build) | the angular pack (`angularMaterial`) |

Each stack ships:

```
stacks/<id>/
├── stack.json                  # id, description, deps map, bundler hints
├── stack-package-deps.hbs      # dep names + ranges injected into the pack's package.json
└── stack-package-devdeps.hbs   # devDep names + ranges injected into the pack's package.json
```

`stack.json` also carries **bundler hints** consumed by the playground
sandbox (`rdcShim`, `importmapReactDomQuery`) so an in-browser preview
of the same pack stays consistent with what the generated `npm install`
would produce.

### How `stack` flows through the pipeline

1. Pack manifest declares `"stack": "v3"`.
2. The pack loader (`src/generator/_packs/`) resolves
   `stacks/v3/stack.json` + the two `*.hbs` snippets.
3. When the bundler renders the pack's `package-json.hbs`, it
   injects the stack's deps/devDeps into the emitted `package.json` —
   the pack's own `package-json.hbs` only lists *pack-specific* deps
   (e.g. `@mantine/core`, not `react`).
4. The same stack id is forwarded into the React generator so seams
   that swap by stack (e.g. `react-router-dom` vs `react-router`) pick
   the right import path.

### Authoring rule

A pack version's `package-json.hbs` MUST NOT restate framework deps
already covered by its stack (`react`, `react-dom`, `react-router*`,
`zod`, `typescript`, `vite`).  Restating them creates drift between
the package.json the bundler emits and the stack's intent.  The
validation step ([§ 8](#8-validating-your-pack)) flags overlap.

## 3. Required emits

The generator dispatches the following 80+ logical names.  Every pack
must emit a file for each.  Logical names are conceptual contracts;
the .hbs file behind each can render whatever the design system needs
to fulfill the contract.

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
| `page-new` | Aggregate creation page: react-hook-form scaffold. |
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

### Cell templates (8)

Cells render an aggregate's columns on the list page and view tables.
Each wraps the pack's `<TableCell>`-equivalent.

| Name | DSL kind |
|---|---|
| `cell-string` | string |
| `cell-id` | id |
| `cell-id-link` | id with link |
| `cell-row-id-link` | row-level id link |
| `cell-datetime` | datetime |
| `cell-bool` | bool |
| `cell-number` | int / decimal |
| `cell-enum` | enum |

### Aggregate piece templates (2)

| Name | Purpose |
|---|---|
| `part-table` | Table rendering aggregate "parts" (collection-of-X on the detail page). |
| `op-button` | A single operation-trigger button on the detail page. |

### Realtime templates (1, tsx only)

| Name | Purpose |
|---|---|
| `realtime-toast` | One toast statement rendered into `RealtimeHandlers.tsx` per `on <channel>.<Event> { toast(…) }` handler (channels.md Part I).  Receives `{{{message}}}` (a TS expression).  Declare the toast lib under `imports["realtime-toast"]`.  Packs whose toast is hook-based may ship an optional `realtime-toast-setup` line rendered inside the component body (chakra v2's `const toast = useToast();`). |

### Walker primitives (22)

The body-walker dispatches every page-metamodel node through these
primitives.  The walker calls `pack.render("primitive-X", vm)` and
expects the pack's template to produce design-system-appropriate JSX.

| Primitive | Use |
|---|---|
| `primitive-heading` | Section heading |
| `primitive-text` | Body text |
| `primitive-divider` | Visual separator |
| `primitive-stack` | Vertical flex container |
| `primitive-group` | Horizontal flex container |
| `primitive-toolbar` | Horizontal toolbar (group variant) |
| `primitive-grid` | Grid container |
| `primitive-container` | Width-constrained container |
| `primitive-empty` | Empty-state message |
| `primitive-button` | Action button |
| `primitive-card` | Card with title + content |
| `primitive-stat` | Stat block (label + value) |
| `primitive-badge` | Status pill / chip |
| `primitive-field` | Labeled text input |
| `primitive-toggle` | Labeled switch / checkbox |
| `primitive-number-field` | Labeled number input |
| `primitive-password-field` | Labeled password input |
| `primitive-loader` | Loading spinner |
| `primitive-anchor` | Link / `<a>` |
| `primitive-image` | `<img>` wrapper |
| `primitive-avatar` | User-avatar component |
| `primitive-tabs` | Tabs container with header + content slots |

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

### `lucide`

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
above for the example systems × the built-in React packs (`mantine`,
`shadcn`, `mui`, `chakra`).  Add your
custom pack to its cases for ongoing coverage:

```sh
LOOM_REACT_BUILD=1 npx vitest run test/generated-react-build.test.ts
```

### Side-by-side visual check

The playground ships three storybook examples (`storybook-mantine.ddd`,
`storybook-shadcn.ddd`, `storybook-components.ddd`).  Generate yours
against the storybook examples and visually compare against Mantine
and shadcn output for the same DDL.

## 9. Architectural rules

These rules constrain pack authorship and the shared-template layer
both.  See [`audits/pack-equivalence-audit.md`](./audits/pack-equivalence-audit.md) for the empirical evidence
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

Or by built-in name — bareword resolves to the family's latest
version, `family@version` pins explicitly:

```
design: mantine                  // → mantine@v9 (current default)
design: "mantine@v7"             // pinned to v7
design: shadcn                   // → shadcn@v4
design: "mui@v5"
design: chakra                   // → chakra@v3
design: ashPhoenix               // forced for phoenixLiveView platform
```

The shipped families: `mantine` (v7, v9), `shadcn` (v3, v4),
`mui` (v5, v7), `chakra` (v2, v3), `ashPhoenix` (v3), the vue
packs `vuetify` (v3 — tracks Vuetify 3) and `shadcnVue` (v1 — the
shadcn-vue flavour: reka-ui + Tailwind 4, source-copy distribution),
the svelte packs `shadcnSvelte` and `flowbite`, and the angular pack
`angularMaterial`.
The current bareword defaults live in `BUILTIN_PACK_LATEST` in
`src/util/builtin-formats.ts`.

The loader (`src/generator/_packs/loader-fs.ts:resolvePackDir`)
resolves identifiers in this order:

1. **Built-in family** — any name matching a registered family
   (with optional `@version`) resolves under
   `<repo>/designs/<family>/<version>/`.
2. **Absolute path** — `design: "/opt/loom-packs/my-pack"` is used
   verbatim.
3. **Relative path** — anything else (e.g. `design: "./my-pack"`,
   `design: "../shared/my-pack"`) is anchored against the directory
   the `.ddd` source file lives in.

Custom packs follow the same `pack.json` + emits contract as
built-in ones — see [§ 2](#2-the-packjson-manifest).  Stack
selection (`"stack": "vN"`) is required for `tsx` custom packs;
the loader still resolves the named stack from the repo's
`stacks/` directory.  Custom packs whose `format` is `heex` go
through the same path but bind against `designs/ashPhoenix/`'s
emit set.

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

## 12. Adding a new pack version — recipe

When a pack family ships a new major (e.g. Mantine 8 → 9), fork the
directory rather than mutating the existing one.  The recipe is
mechanical; the upstream library's own migration guide is doing the
real thinking.

### Step 1 — Audit before forking

Read the upstream migration guide.  Then grep the existing pack's
templates for every deprecated / renamed API.  **No match = no
template change needed** in that area; the migration is
package-json-only.

```bash
# Search for prop renames documented in the upstream migration guide.
grep -nE 'color=|isOpen=|gutter=|in=|spacing=' designs/<family>/<vOld>/*.hbs

# Search for components that were renamed or removed.
grep -nE '<Divider|<Modal|<Drawer\b' designs/<family>/<vOld>/*.hbs

# Search for hooks whose signature changed.
grep -nE 'useToast|useDisclosure|useFullscreen' designs/<family>/<vOld>/*.hbs

# Search for upstream package imports that may have moved subpaths.
grep -nE "from \"@<family>/" designs/<family>/<vOld>/*.hbs
```

### Step 2 — Fork the directory

```bash
cp -r designs/<family>/<vOld> designs/<family>/<vNew>
# Bump the manifest's `version` field to match the directory.
sed -i 's/"version": "<vOld>"/"version": "<vNew>"/' \
  designs/<family>/<vNew>/pack.json
```

The loader cross-checks `pack.json`'s `version` against the parent
directory name and throws on mismatch.  The cross-check catches
copy-paste forks that leave the manifest stale.

### Step 3 — Pick a stack

The cross-cutting framework deps (React, react-router, zod, Vite, TS)
live in `stacks/<id>/`, not in each pack.  Decide which stack the new
pack version targets (see [§ 2a](#2a-stacks-and-how-a-pack-picks-one)):

- A pack version that requires **React 19 + RR 7 + zod 4** declares `"stack": "v3"`.
- A pack version still on **React 18 + RR 6 + zod 3** declares `"stack": "v1"`.
- If the framework baseline you need doesn't exist yet, create a new
  stack first (see [§ 2a — Adding a new stack](#adding-a-new-stack)).

Then `designs/<family>/<vNew>/package-json.hbs` carries **only the
pack-specific deps**, with the framework deps pulled in via the
stack partials:

```handlebars
{
  ...
  "dependencies": {
{{> stack-package-deps}},
    "@<family>/core": "^<newMajor>.0.0",
    ... pack-specific deps only ...
  },
  "devDependencies": {
{{> stack-package-devdeps}}
  }
}
```

If a pack needs an extra devDep the stack doesn't supply (shadcn's
`@types/node`, say), append it after the partial.

### Step 4 — Apply template changes

For each row in your Step-1 worklist, edit the templates.  Mechanical
piece (boolean prop renames, component renames) are amenable to
`sed -i` or the upstream codemod (chakra and mui ship them).
Compound-component restructuring (Chakra v3) is hand-work.

**Always emit named-import `createRoot` in `main.hbs`**:

```tsx
// CORRECT — works under both React 18 and 19:
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<App />);

// WRONG under React 19 — type-checks but explodes at runtime:
import ReactDOM from "react-dom/client";
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

### Step 5 — Register the new version

Add the qualified name to `src/util/builtin-formats.ts`:

```ts
export const BUILTIN_PACK_FORMATS = {
  // ... existing entries ...
  "<family>@<vNew>": "tsx",  // or "heex" for HEEx (Phoenix LiveView) packs
} as const satisfies Record<string, "tsx" | "heex">;
```

**Don't flip `BUILTIN_PACK_LATEST` in the same PR** — that's a
separate "promote" PR paired with refreshing the byte-equivalence
fixture under `test/fixtures/baseline-output/`.

### Step 6 — Add the version to the test matrix

`test/generated-react-build.test.ts`:

```ts
const PACKS: readonly PackSpec[] = [
  // ... existing entries ...
  { family: "<family>", version: "<vNew>" },
];
```

`.github/workflows/generated-react-build.yml`:

```yaml
pack: ["mantine@v7", "mantine@v9", "shadcn@v3", "shadcn@v4", ..., "<family>@<vNew>"]
```

### Step 7 — Add a pinned storybook example to the playground

So the in-browser dropdown can demo old + new side-by-side:

```bash
cp web/src/examples/storybook-<family>.ddd \
   web/src/examples/storybook-<family>-<vNew>.ddd
# Rewrite the `design:` slot to the pinned form.
sed -i 's/design: <family>/design: "<family>@<vNew>"/' \
  web/src/examples/storybook-<family>-<vNew>.ddd
```

Register it in `web/src/examples/index.ts`.

### Step 8 — Verify

```bash
# Unit suite — should still pass clean.
npm test

# The new shard must pass both tsc --noEmit AND vite build.
LOOM_REACT_BUILD_CASE="web/src/examples/sales-system.ddd:<family>@<vNew>" \
  npx vitest run test/generated-react-build.test.ts

# Sanity-check at least one other shard didn't regress.
LOOM_REACT_BUILD_CASE="web/src/examples/sales-system.ddd:<family>@<vOld>" \
  npx vitest run test/generated-react-build.test.ts

# Playground build clean.
cd web && npm run build

# Playground e2e — at least the editor + workspace-persistence + the
# new pinned-storybook spec.
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test \
  e2e/editor.spec.ts \
  e2e/workspace-persistence.spec.ts \
  e2e/<family>-versions-pinned.spec.ts
```

**The `vite build` step inside the shard is non-negotiable** — it
catches class-shape mismatches `tsc --noEmit` lets through.

### Step 9 — Promote to default (follow-up PR)

In a separate PR after the new version has soaked:

1. Flip `BUILTIN_PACK_LATEST.<family>` from `<vOld>` to `<vNew>` in
   `src/util/builtin-formats.ts`.
2. Regenerate the byte-equivalence baseline:

   ```bash
   node scripts/capture-baseline-fixture.mjs
   ```

3. Update `test/playground/loader-vfs.test.ts`'s bareword expectation:

   ```ts
   expect(resolvePackDir("<family>")).toBe("/designs/<family>/<vNew>");
   ```

### Anti-patterns to avoid

| anti-pattern | why |
| --- | --- |
| Skipping `vite build` in CI to "save time" | tsc lets type-correct-but-runtime-broken code through |
| Skipping the runtime preview e2e for a new stack | only the runtime gate catches regressions that type-check + bundle |
| Re-stating React / router / zod / Vite / TS deps in `package-json.hbs` | the stack abstraction exists precisely to prevent this drift |
| Flipping `BUILTIN_PACK_LATEST` in the same PR as the new pack | byte-equivalence fixture goes stale; two unrelated changes in one diff |
| Keeping `forwardRef` wrappers / `<Context.Provider>` "for symmetry with v7" | new pack versions are clean breaks — no compat shims inside one pack |
| Adopting `react-router-dom` (v6 name) in new packs targeting an RR-7 stack | v7 renamed to `react-router` |
| Letting `manifest.version` (or `manifest.stack`) drift from reality | loader throws on version/dir mismatch; a wrong `stack` resolves the wrong framework deps |
| Externalising React for a React-19 stack | the duplicate-`ReactSharedInternals` bug — React-19 stacks inline React on purpose |

## 13. References

- [`audits/pack-equivalence-audit.md`](./audits/pack-equivalence-audit.md) — what's shared vs per-pack, with evidence
- [`plans/per-pack-migration.md`](old/plans/per-pack-migration.md) — per-library historical migration notes (mantine→v9, mui→v7, chakra→v3, shadcn→v4)
- `src/generator/_packs/loader.ts` — pure compile core
- `src/generator/_packs/loader-fs.ts` — Node FS adapter
- `web/src/build/loader-vfs.ts` — playground VFS adapter
- `src/util/builtin-formats.ts` — built-in pack format map + bareword defaults
- `stacks/<id>/` — stack definitions (`v1`, `v3`, `sv1`, `vue1`, `ng1`)
- `designs/<family>/<version>/` — reference implementations
- `test/generated-react-build.test.ts` — the static-validation gate
- `test/pack-manifest.test.ts` — manifest-shape contract tests
- `test/template-shared-layer.test.ts` — shared-source contract tests
