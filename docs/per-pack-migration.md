# Per-pack migration notes

Distilled scope for each upcoming Phase 1.X PR. Each section captures
**what changes in the upstream library** and **what that means for the
templates this pack ships**. Pair this doc with
[`adding-a-pack-version.md`](./adding-a-pack-version.md) (the recipe)
and [`stack-versions-audit.md`](./stack-versions-audit.md) (the
version table).

The migration-doc URLs at the top of each section are the canonical
authority — these notes are the **scoped subset** of the breaking
changes that affect a template-driven code generator emitting ~50–80
files per project. Anything not listed here was checked and didn't
apply to our use, **or** wasn't relevant (DX perks, perf notes,
non-breaking additions).

---

## Phase 1.1 — `tailwind@v4` + `shadcn@v4`

**Migration guides:**
- <https://tailwindcss.com/docs/upgrade-guide>
- Run the official codemod: `npx @tailwindcss/upgrade` against a
  generated project — captures most of the renames, then audit
  manually.

**Affects:** `designs/shadcn/v4/*.hbs` — primarily the CSS files and
`tailwind-config.hbs`. `tailwind-config.hbs` may be deleted
entirely in favour of `@theme` directives in CSS.

| change | where in our templates |
| --- | --- |
| `tailwind.config.js` optional; CSS-first config via `@theme` directive in CSS | drop `tailwind-config.hbs`; restructure `globals.css.hbs` / `index.css.hbs` to declare tokens via `@theme { --color-primary: ...; }` |
| `@tailwind base; @tailwind components; @tailwind utilities;` → `@import "tailwindcss";` | top of every CSS template |
| PostCSS plugin renamed: `tailwindcss` → `@tailwindcss/postcss` | `postcss.config.js.hbs` (if present); `package-json.hbs` devDeps |
| Utility renames: `shadow-sm` → `shadow-xs`, `shadow` → `shadow-sm`; `rounded-sm` → `rounded-xs`, `rounded` → `rounded-sm`; `blur-sm` → `blur-xs`, `blur` → `blur-sm`; `ring` → `ring-3` | grep every template for these tokens; the codemod handles most |
| Opacity utilities removed: `bg-opacity-50` → `bg-black/50` (modifier syntax) | grep `\b\w+-opacity-\d+` across templates |
| Border default colour: `gray-200` → `currentColor` | wherever we use `border` without a color modifier, append `border-gray-200` (or whatever) to keep visual parity |
| `!important` position: `!flex` → `flex!` (now suffix) | rare in our templates; double-check |
| Variant stacking is now left-to-right: `*:first:pt-0` (not `first:*:pt-0`) | check variant ordering on each stacked utility |
| `lucide-react` 0.x → 1.x: 13 brand icons removed (Chromium, Codepen, Codesandbox, Dribbble, Facebook, Figma, Framer, Github, Gitlab, Instagram, LinkedIn, Pocket, RailSymbol, Slack) | audit imports; replace any brand icons with inline SVG |
| `lucide-react` UMD build removed | irrelevant — we always import ESM |
| `tailwindcss-animate` is unnecessary on Tailwind 4 (built in) | drop from `package-json.hbs` |

**Don't forget:** `vite-config.hbs` may need the `@tailwindcss/vite`
plugin replacing the previous PostCSS-based setup.

---

## Phase 1.2 — `mantine@v9` ✅ shipped (PR #148 + #149)

**Migration guides:**
- <https://mantine.dev/guides/7x-to-8x/>
- <https://mantine.dev/guides/8x-to-9x/>

**Outcome:** ~zero template changes. The mantine pack happens to use
none of the v9-deprecated props. Only `package-json.hbs` deps differ
between v7 and v9, plus one runtime fix (`main.hbs` switched to
named-import `createRoot` — see "Lessons learned" in
`pack-versioning-plan.md`).

For reference if this needs revisiting:

| change | did it apply to our pack? |
| --- | --- |
| Requires React 19.2+ | yes — `package-json.hbs` pins `^19.2.0` |
| `@mantine/dates` switched to date strings | no — we use plain `<TextInput type="datetime-local">` |
| Carousel embla v8 | no — we don't ship Carousel |
| `Text` / `Anchor` `color` → `c` | no — we don't use the prop |
| `Collapse` `in` → `expanded` | no — we don't use Collapse |
| `Grid` `gutter` → `gap` | no — we don't use Grid (we use `Group`/`Stack`) |
| `useFullscreen` split into two hooks | no — we don't use it |
| Default border-radius 4px → 8px | yes (visual change accepted) |

---

## Phase 1.3 — `mui@v7`

**Migration guides:**
- <https://mui.com/material-ui/migration/upgrade-to-v6/>
- <https://mui.com/material-ui/migration/upgrade-to-v7/>
- Codemod: `npx @mui/codemod@latest v6.0.0/grid-v2-props <path>`

**Affects:** `designs/mui/v7/*.hbs` — primarily layout templates
(`app-shell`, `page-list`, `page-detail`) and theme.

| change | where in our templates |
| --- | --- |
| `Grid` (formerly `Grid2`) replaces old `Grid`; the old becomes `GridLegacy` | every `<Grid>` JSX use; semantics largely the same but breakpoint props use the new object shape `xs={...}` → `size={{ xs: 12 }}` |
| `createMuiTheme` removed; use `createTheme` | `theme.hbs` |
| Deep imports removed: `@mui/material/styles/createTheme` → use barrel `@mui/material/styles` | grep `@mui/material/styles/` |
| `ListItem` button-shape props removed; use `ListItemButton` where interactive | navigation templates (`app-shell.hbs`) |
| Pigment CSS (zero-runtime); dynamic `sx` props may not work the same way | audit any `sx` that depends on runtime values; static sx fine |
| `InputLabel` size prop: `'normal'` → `'medium'` | usually omitted; check explicit `size=` usages |
| `Accordion` summary wraps in `<h3>` by default | semantic HTML change; visual identical |
| `Divider` vertical uses `<div>` (was `<hr>`) | irrelevant unless we target the tag in CSS |
| Browser support: IE11 dropped; Node 14+, TypeScript 4.7+ | we already meet all of these |

**Note on Pigment CSS adoption:** v7 supports Pigment CSS but doesn't
require it. The lower-risk path is to ship v7 without Pigment first
and revisit later. Pigment requires Vite plugin config changes and
build-time style extraction — non-trivial.

---

## Phase 1.4 — `chakra@v3` (largest delta)

**Migration guide:** <https://www.chakra-ui.com/docs/get-started/migration>
**Codemod:** `npx @chakra-ui/codemod migrate-v3 <path>` (partial; manual cleanup still needed)

**Affects:** `designs/chakra/v3/*.hbs` — near-total template rewrite.
The codemod handles prop renames; theme and compound components are
hand-work.

### Provider / theme (every entrypoint)

| change | where in our templates |
| --- | --- |
| `ChakraProvider theme={theme}` → `ChakraProvider value={system}` | `main.hbs` |
| `extendTheme(...)` → `createSystem(defaultConfig, { theme: { tokens: { colors: { brand: { value: "#..." } } } } })` — every token value wrapped in `{ value: ... }` | `theme.hbs` |
| Color mode: `ColorModeProvider` / `useColorMode` removed; v3 expects `next-themes` | add a `provider.tsx` snippet that wires both `ChakraProvider` and `next-themes`'s `ThemeProvider` |

### Universal prop renames (search-and-replace pass)

| change | locations |
| --- | --- |
| `isOpen` → `open` | `Drawer`, `Modal`/`Dialog`, `Popover`, `Tooltip` |
| `isDisabled` → `disabled` | every form input, every button |
| `isInvalid` → `invalid` | form-field templates |
| `isRequired` → `required` | form-field templates |
| `isChecked` → `checked` | `Checkbox`, `Radio`, `Switch` |
| `isLoading` → `loading` | `Button`, `IconButton` |
| `isActive` → `data-active` | navigation links |
| `isRound` → `borderRadius="full"` | `IconButton`, `Avatar` |
| `colorScheme` → `colorPalette` | every coloured component |
| `spacing` (Stack/Group) → `gap` | every stack-shaped layout |
| `onClose` (disclosure) → `onOpenChange` | `Drawer`, `Modal`, `Popover` |
| `onChange` on `Select` / `RadioGroup` → `onValueChange` | form inputs |

### Renamed components

| before | after |
| --- | --- |
| `Divider` | `Separator` |
| `Modal*` (whole suite) | `Dialog.*` |
| `AlertIcon` | `Alert.Indicator` |

### Compound-component rewrites (biggest template effort)

Every component below: spread its previously-monolithic JSX into
named sub-components. The codemod handles boolean renames but
**not** the compound restructure.

- `Alert` → `Alert.Root` / `Alert.Indicator` / `Alert.Title` / `Alert.Description`
- `Drawer` / `Modal` → `Drawer.Root` / `Drawer.Backdrop` / `Drawer.Positioner` / `Drawer.Content` / `Drawer.Header` / `Drawer.Body` / `Drawer.Footer` / `Drawer.CloseTrigger`
- `Dialog` (the renamed `Modal`) → same shape as `Drawer`
- `List` / `ListItem` → `List.Root` / `List.Item` (+ optional `List.Indicator`)
- `Checkbox` → `Checkbox.Root` / `Checkbox.Control` / `Checkbox.Indicator` / `Checkbox.Label`
- `Radio` → `RadioGroup.Root` / `RadioGroup.Item` / `RadioGroup.ItemIndicator` / `RadioGroup.ItemText`
- `Select` → `Select.Root` / `Select.Trigger` / `Select.Content` / `Select.Item`
- `Button` `leftIcon=` / `rightIcon=` props removed → render icon as child
- `IconButton` `icon=` prop removed → render icon as child

### Hooks / utilities

| change | locations |
| --- | --- |
| `useDisclosure` shape: returns `{ open, onOpen, onClose, onOpenChange }` (was `{ isOpen, ... }`) | every place we use it |
| `useToast` removed → `createToaster` + `<Toaster />` snippet mounted in provider | new `toaster.tsx` snippet; replace `toast({ ... })` with `toaster.create({ ... })` |
| `Tooltip` becomes a snippet (`@/components/ui/tooltip`); `label` prop → `content` | wherever we use Tooltip |

### Styling

| change | locations |
| --- | --- |
| `sx` prop removed | rewrite using the `css` prop with `&` selectors for nested styles |
| Simple style props (`p`, `m`, `bg`, `color`) carry over | most templates unaffected |

### Snippet files to add (Chakra v3 ships these as code, not config)

- `src/components/ui/provider.tsx` — wraps `ChakraProvider` + `next-themes` provider
- `src/components/ui/toaster.tsx` — exports the `toaster` instance + `<Toaster />` mount point
- `src/components/ui/tooltip.tsx` — the v3 Tooltip wrapper
- `src/components/ui/color-mode.tsx` — `useColorMode` adapter over `next-themes`

These belong in `shellFiles` (or shipped via templates) under the
chakra@v3 pack. New `pack.json` `emits`/`shellFiles` entries
required.

---

## Phase 1.5 — `ashPhoenix@v3.24` (in-place minor bump within v3)

**Migration guides:**
- <https://www.phoenixdiff.org/> for Phoenix 1.7 → 1.8 diff
- Ash CHANGELOG (3.0 → 3.24): <https://hexdocs.pm/ash/changelog.html>

**Affects:** `designs/ashPhoenix/v3/*.hbs`. Minor bump within `v3/`
— no new directory. If the changes accumulate to a hard break, fork
to `v4/` instead.

| change | where in our templates |
| --- | --- |
| Phoenix 1.7 → 1.8: single `root.html.heex` layout (was per-controller layouts) | `app-layout.heex.hbs` / `app-shell.heex.hbs` |
| Endpoint config access via `Application.compile_env/3` (not runtime `config_env()` in module attrs) | `config.exs.hbs` |
| Erlang/OTP 25+ required (was 24+) | document in Dockerfile/CI; bump base image |
| Controller `use Phoenix.Controller` now requires `:formats` keyword | controllers .hbs templates |
| Deprecated headers (`x-download-options`, `x-frame-options`) no longer sent by default | irrelevant unless we depended on them |
| Ash 3.0 → 3.24 minors: safe within `~> 3.0` constraint | tighten to `~> 3.24` to harvest fixes |

**Don't forget:** `postgrex: ">= 0.0.0"` is currently a wide-open
range — tighten to `~> 0.20` in the same PR. Same trap as the
Chakra peerDep that bit PR #146.

---

## Cross-cutting baseline (applies to every new pack version)

These changes ride with every Phase 1.X PR's `package-json.hbs`. See
also [`adding-a-pack-version.md`](./adding-a-pack-version.md) for
the recipe.

### React 18 → 19

- Drop `forwardRef` wrappers; refs flow through as plain props.
- `<Context.Provider value={...}>` → `<Context value={...}>`.
- Form templates can adopt `useActionState` + `useFormStatus`.
- Ref callbacks can return a cleanup function — adopt where it fits.
- **`main.hbs` MUST use named-import `createRoot`** (PR #149 lesson):

  ```tsx
  import { createRoot } from "react-dom/client";
  createRoot(document.getElementById("root")!).render(<App />);
  ```

### react-router 6 → 7 (framework mode)

- Package renamed: `react-router-dom` → `react-router`.
- Adopt framework mode via `@react-router/dev` Vite plugin.
- Route file conventions: `app/routes/*.tsx` (or pinned via `routes.ts`).
- Loaders return raw objects (drop `json(...)`, `defer(...)`).
- Import `Link`, `useNavigate`, etc. from `react-router` (not `react-router-dom`).
- The Vite plugin needs wiring in `vite-config.hbs`.

### Vite 5 → 8

- Node 20+ required (CI's `setup-node` already at 20; verify).
- esbuild → oxc, Rollup → Rolldown internally (mostly transparent for
  template-emitted configs).
- `optimizeDeps.esbuildOptions` → `optimizeDeps.rolldownOptions` if
  used (rare in our templates).
- Default browser targets raised (Safari 16.4+, Chrome 111+).

### TypeScript 5.7 → 6.0

- `strict: true` is the new default; our templates already opt in.
- `module: "esnext"` default; we already set this.
- `target: "es2025"` default — current templates set `es2022`; can
  leave explicit or bump.
- `types: []` default — must list `@types/node`, `@types/react`, etc.
  explicitly in `tsconfig.hbs`.
- `moduleResolution: "node"` removed; use `"nodenext"` or
  `"bundler"`. Vite projects want `"bundler"`.
- `import ... assert { type: "json" }` → `import ... with { type:
  "json" }`. JSON imports in templates need this rename.

### zod 3 → 4

- `.merge()` deprecated → use `.extend()`.
- `.nonempty()` no longer narrows tuple type — accept `T[]` not `[T,
  ...T[]]`.
- `.int()` accepts only safe integers (smaller range).
- String format validators: pattern unchanged (`z.string().email()`).
- `error` parameter unified — replaces `message`, `invalid_type_error`, `required_error`.
- Codemod: `zod-v3-to-v4` (community).

### @hookform/resolvers 3 → 5

- v5 requires zod 4 peer; bumps together with the zod 3→4 change.
- Skips v4 (which had its own breakages); migration docs cover both.

### framer-motion 11 → 12

- For React components (`<motion.div>` etc.), **no breaking changes**.
- Vanilla JS gestures (`inView`, `hover`, `press`) have different
  callback signatures, but we don't use those.
