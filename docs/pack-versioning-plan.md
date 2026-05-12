# Loom stack modernization — pack versioning + latest stable everywhere

> **Status:** Phase 0 + Phase 1.2 (mantine@v9) shipped. See
> [`stack-versions-audit.md`](./stack-versions-audit.md) for the rolling
> version audit, [`per-pack-migration.md`](./per-pack-migration.md) for
> the per-pack scope of the remaining Phase 1 PRs, and
> [`adding-a-pack-version.md`](./adding-a-pack-version.md) for the
> recipe distilled from PR #148.

## Status tracker

| phase | scope | PR | status |
| --- | --- | --- | --- |
| 0 | Versioning machinery — `design: "family@vN"`, directory layout, validator + IR + loaders | #147 | ✅ merged |
| 1.2 | `mantine@v9` (React 19) — opt-in via pinned form; bareword default still v7 | #148 + #149 fix | ✅ merged |
| 1.1 | `tailwind@v4` + `shadcn@v4` (CSS-first config, utility renames) | — | pending |
| 1.3 | `mui@v7` (Pigment CSS, Grid v2) | — | pending |
| 1.4 | `chakra@v3` (compound components, `createSystem`, `toaster` — largest delta) | — | pending |
| 1.5 | `ashPhoenix` minor → Phoenix 1.8 + Ash 3.24 | — | pending |
| 1.X | Promote `BUILTIN_PACK_LATEST.mantine = "v9"` + refresh `test/fixtures/baseline-output/` | — | pending |
| 2.a | Hono backend deps (hono 4.6→4.12; drizzle 0.36→0.45; zod 3→4) | — | pending |
| 2.b | Phoenix backend (tighten `postgrex: ">= 0.0.0"`; phoenix 1.7→1.8) | — | pending |
| 2.c | .NET deps (deferred — .NET 8 LTS through 2026-11) | — | not urgent |

## Context

Three findings from this session point at the same gap:

1. **Today's Chakra bundle error.** `@chakra-ui/icons@2.2.6` declares `peerDependencies: { "@chakra-ui/react": ">=2.0.0" }`. esm.sh resolved that loose range transitively to Chakra v3, which dropped `forwardRef`. PR #146 fixed the symptom (deleted the icons dep), but the root issue — we're locked to old majors — remains.

2. **Every pack is one or more majors behind upstream as of 2026-05.** Mantine v7 (latest v9), Chakra v2 (latest v3), MUI v5 (latest v7), Tailwind 3 (latest 4), React 18 (latest 19), Vite 5 (latest 8), TS 5.7 (latest 6), react-router 6 (latest 7), zod 3 (latest 4), drizzle 0.36 (latest 0.45+).

3. **No mechanism to ship a new pack version without breaking existing `.ddd` files.** Today `design: mantine` resolves to one directory. Replacing it would break every project that points at it.

**Plan:** introduce a pack-versioning axis (Phase 0), then ship a new major-version pack per upstream library (Phase 1+). Old packs stay loadable; new pack versions don't carry transitional shims; bareword `design: mantine` auto-rolls forward via a `BUILTIN_PACK_LATEST` table (user choice — "cutting safe edge").

## Goals

- Every emitted project compiles + bundles against current latest-stable.
- Old pack versions stay available (`design: "mantine@v7"`) so existing projects don't break when new packs land.
- `design: mantine` (bareword) auto-resolves to the toolchain's current default; flipping the default rolls every bareword source forward.
- New pack versions adopt the new APIs properly — no technical debt (e.g. react-router 7 framework mode, Tailwind 4 CSS-first, Chakra 3 compound components).
- Architecture generalises to backends if/when needed (`platform: hono@4`), but we don't pre-build it.

## Non-goals

- Compat shims that paper over upstream breaking changes inside a new pack.
- A `loom-version` field in `.ddd` sources. Bareword mutability is accepted; explicit pins handle determinism.
- A grammar-level dotted version syntax. The existing `STRING` alternative on `DesignPack` already accepts `design: "mantine@v9"` and works with zero grammar regen.

## Architecture decisions

| decision | choice | rationale |
| --- | --- | --- |
| Directory layout | `designs/<family>/<vN>/pack.json` | One path-segment append for loaders; keeps each pack version's invariants (one manifest, one set of siblings). |
| DSL syntax | `design: "mantine@v9"` (quoted, STRING alt) | No grammar text change. Validator + loader are the resolution authority. |
| Bareword default | Auto-rolls to `BUILTIN_PACK_LATEST[family]` | User choice — cutting-safe-edge default. Pinning is opt-in via the quoted form. |
| Manifest `version` field | Load-bearing — must equal parent dir name (`v9`); loader cross-checks | Today the field is metadata-only; repurpose to prevent copy-paste shadowing. |
| Cross-pack deps (react/vite/tsconfig) | Live in each pack's `package-json.hbs`, already pack-owned | Each pack version carries its full manifest, so `mantine@v7` stays on React 18 while `mantine@v9` runs on React 19. |
| Backend pinning | Inline strings; bump in place | Hono/drizzle/.NET/Phoenix each have one consumer. YAGNI for `platform: hono@4` syntax. |
| react-router 7 mode | Framework mode in new packs | User rule: "no technical debt". Library mode is a transitional shim. |
| TS version target | 6.0 in new packs | Latest stable; ship a tsconfig that opts into TS 6 defaults explicitly. |
| Vite version target | 8 in new packs | Latest stable; new packs accept oxc/rolldown. |

## Phase 0 — versioning machinery (no behaviour change)

**Goal:** introduce the version axis without changing any generated output. Every existing project compiles to byte-identical files. Each item below is concrete and code-level.

### Move existing packs into `vN/` subdirs

`git mv` only — each existing pack becomes its current upstream major:

| pack | from | to |
| --- | --- | --- |
| mantine | `designs/mantine/` | `designs/mantine/v7/` |
| chakra | `designs/chakra/` | `designs/chakra/v2/` |
| mui | `designs/mui/` | `designs/mui/v5/` |
| shadcn | `designs/shadcn/` | `designs/shadcn/v3/` (keyed on Tailwind 3) |
| ashPhoenix | `designs/ashPhoenix/` | `designs/ashPhoenix/v3/` (Ash major) |

Bump each `pack.json` `"version"` from the placeholder `"0.1.0"` to `"v7"` / `"v2"` / etc.

### `src/generator/_packs/builtin-formats.ts`

Rewrite to version-keyed maps + a parsing helper:

```ts
export const BUILTIN_PACK_FORMATS = {
  "mantine@v7":    "tsx",
  "chakra@v2":     "tsx",
  "mui@v5":        "tsx",
  "shadcn@v3":     "tsx",
  "ashPhoenix@v3": "heex",
} as const satisfies Record<string, "tsx" | "heex">;

export const BUILTIN_PACK_LATEST = {
  mantine: "v7", chakra: "v2", mui: "v5", shadcn: "v3", ashPhoenix: "v3",
} as const satisfies Record<string, string>;

export type BuiltinPackFamily = keyof typeof BUILTIN_PACK_LATEST;

export function parseBuiltinDesignRef(s: string):
  | { family: BuiltinPackFamily; version: string; qualified: string }
  | null {
  if (s.startsWith(".") || s.startsWith("/")) return null;     // custom path
  const at = s.indexOf("@");
  const family = (at === -1 ? s : s.slice(0, at)) as BuiltinPackFamily;
  if (!(family in BUILTIN_PACK_LATEST)) return null;
  const version = at === -1 ? BUILTIN_PACK_LATEST[family] : s.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
}

export function packFormatForBuiltin(s: string): "tsx" | "heex" | undefined {
  const parsed = parseBuiltinDesignRef(s);
  return parsed ? (BUILTIN_PACK_FORMATS as Record<string, "tsx" | "heex">)[parsed.qualified] : undefined;
}
```

### Loaders

- **`src/generator/_packs/loader-fs.ts:60`** — `resolvePackDir` switches on `parseBuiltinDesignRef(ui)`; built-ins go to `path.join(repoRoot(), "designs", parsed.family, parsed.version)`. Delete the standalone `BUILTIN_PACKS` set at line 53 — derive from `parseBuiltinDesignRef` instead.
- **`web/src/build/loader-vfs.ts:77`** — same change; VFS paths become `/designs/<family>/<version>`. Delete the hardcoded set at line 35 (which currently omits `ashPhoenix`); the derive-from-formats fix lands as a free side effect.
- **`web/src/build/template-bundled.ts`** — glob pattern from `designs/*/pack.json` to `designs/*/*/pack.json`. Update the `parseDesignPath` helper to extract both `family` and `version` segments. Seed every discovered pack into `/designs/<family>/<version>/...` in the worker VFS.

### Validator

`src/language/ddd-validator.ts:421-463` (`checkDeployableDesignPack`):
- Uses `parseBuiltinDesignRef` so `design: mantine` and `design: "mantine@v7"` both resolve identically.
- Add a new error path: bareword family known but specific version not in `BUILTIN_PACK_FORMATS` (e.g. `"mantine@v999"`). Message lists available versions for the family.
- `builtinPackNamesForFormat` keeps returning bareword family names — error suggestions stay readable.

### IR + lowering

- `src/ir/lower.ts:475-495` always emits a **fully-qualified** design string after lowering. Add a `qualifyDesign(raw, fallback)` helper; lowering writes `qualifyDesign(d.design, "mantine")` (or `"ashPhoenix"` for Phoenix).
- `src/ir/loom-ir.ts:707` — update the `design?: string` jsdoc: "fully qualified after lowering (`family@vN` or a custom path); callers don't need to re-resolve the toolchain default."

### Generator dispatch

`src/generator/react/index.ts:106-107`:

```ts
// `deployable.design` is fully qualified at lower.ts (e.g. "mantine@v7").
const design = deployable.design ?? "mantine@v7";
const pack = loadPack(resolvePackDir(design));
```

### Tests

- `test/generated-react-build.test.ts:74-75` — `PACKS` becomes `Array<{ family, version }>`. `injectDesign` writes the quoted qualified form (`design: "mantine@v7"`). Phase 0 matrix stays 7 × 4 = 28 cases. CI shard key becomes `<ddd>:<family>@<version>`.
- `test/validation.test.ts:547` — new cases: `"mantine@v7"` accepted on react frontend; `"mantine@v999"` rejected with a version-listing error; existing bareword tests stay green.

### Pack manifest

`src/generator/_packs/loader.ts:48` — update the `PackManifest.version` jsdoc: "load-bearing; must equal the parent directory name (e.g. `v9` for `designs/mantine/v9/`). Loader throws on mismatch." Add the cross-check at load time in both `loader-fs.ts` and `loader-vfs.ts`.

### Storybook examples

Keep bareword `design: mantine` / `design: shadcn` / etc. in `web/src/examples/storybook-*.ddd`. They auto-track the toolchain default — desired behaviour for the demo dropdown. Phase 1.X PRs add a *second* pinned storybook variant per family (e.g. `storybook-mantine-v9.ddd`) so the playground shows both old and new side-by-side.

### Phase 0 acceptance

- `npm run langium:generate && npm run build && npm test` clean (no AST drift, 75+ suites green).
- `LOOM_REACT_BUILD_CASE=web/src/examples/sales-system.ddd:mantine@v7` shard passes; emits byte-identical TSX to today's `mantine` shard.
- A `.ddd` source pinned to `design: "mantine@v7"` compiles end-to-end byte-identical to one with `design: mantine`.
- `design: "mantine@v999"` produces a hard validator error listing available versions.
- Playground: build, open a storybook example, switch between `design: mantine` and `design: "mantine@v7"` via the editor — both should generate identical files; `design: "mantine@v999"` shows the error in the Problems panel.

## Phase 1 — per-pack new versions (one PR each)

Each PR drops a new `designs/<family>/<vNN>/` directory, flips `BUILTIN_PACK_LATEST[family]` to the new version, adds a pinned storybook variant, and inherits the expanded test matrix. Order driven by ecosystem readiness (Tailwind unblocks shadcn; Mantine 9 requires React 19 — also baseline for chakra@v3 and mui@v7).

Each new pack version's `package-json.hbs` targets the **per-pack cutting-edge baseline**:
- `react`/`react-dom`: `^19.2.0`
- `react-router`: `^7.0.0` (note: package renamed from `react-router-dom`) — **framework mode** via `@react-router/dev` Vite plugin
- `vite`: `^8.0.0`
- `typescript`: `^6.0.0`
- `zod`: `^4.0.0`
- `@hookform/resolvers`: `^5.0.0`
- `framer-motion`/`motion`: `^12.0.0`
- `lucide-react`: `^1.0.0` (audit removed brand icons)

### 1.1 `tailwind@v4` + `shadcn@v4`
Migration: <https://tailwindcss.com/docs/upgrade-guide>. CSS-first `@theme`, drop `tailwind.config.js`, `@tailwindcss/postcss` plugin, utility renames (`shadow-sm`→`shadow-xs`, opacity props → modifiers, `ring`→`ring-3`). Border color default changed to `currentColor`. Codemod: `@tailwindcss/upgrade`. `BUILTIN_PACK_LATEST.shadcn = "v4"`.

### 1.2 `mantine@v9`
Migration: <https://mantine.dev/guides/7x-to-8x/> + <https://mantine.dev/guides/8x-to-9x/>. Requires React 19.2+. Date strings replace Date objects; `color`→`c` (Text/Anchor); `in`→`expanded` (Collapse); `gutter`→`gap` (Grid); `useFullscreen` split. Default border-radius 4→8px (accept visual diff). `BUILTIN_PACK_LATEST.mantine = "v9"`.

### 1.3 `mui@v7`
Migration: <https://mui.com/material-ui/migration/upgrade-to-v6/> + <https://mui.com/material-ui/migration/upgrade-to-v7/>. Pigment CSS (zero-runtime); `Grid` (formerly Grid2) replaces old; `createTheme` (not `createMuiTheme`); deep imports removed; `ListItem` → `ListItemButton` where interactive. Codemod: `v6.0.0/grid-v2-props`. `BUILTIN_PACK_LATEST.mui = "v7"`.

### 1.4 `chakra@v3` (largest delta)
Migration: <https://www.chakra-ui.com/docs/get-started/migration>. Near-total template rewrite. `extendTheme`→`createSystem` with token-value wrapping. `ChakraProvider value={system}`. Compound components everywhere: `Drawer.*`, `Dialog.*`, `Alert.Root/Indicator`, `Checkbox.Root/Control`, `RadioGroup.*`, `Select.Root/Trigger/Content/Item`, `List.Root/Item`. Boolean prop rename pass: `isOpen→open`, `isDisabled→disabled`, `colorScheme→colorPalette`, `spacing→gap`, `onClose→onOpenChange`. `Divider→Separator`, `Modal*→Dialog.*`. `useToast`→`createToaster`+`<Toaster />` snippet. `useColorMode`→`next-themes` adapter snippet. Button/IconButton: icon props → children. Codemod: `@chakra-ui/codemod` (partial). `BUILTIN_PACK_LATEST.chakra = "v3"`.

### 1.5 `ashPhoenix@v3.24` (Phoenix 1.8)
Migration: <https://www.phoenixdiff.org/> + Phoenix 1.8 changelog. Single `root.html.heex` layout; `Application.compile_env/3` for endpoint config; Erlang/OTP 25+; controllers' `use` requires `:formats`. Likely an in-place bump within `designs/ashPhoenix/v3/` (semver minor within Ash 3.x), no new directory.

### Cross-cutting template changes inside each new pack

- React 19: drop `forwardRef`; switch `<Context.Provider>`→`<Context>`; use `useActionState`/`useFormStatus` in form templates; opt into ref-callback cleanup where applicable.
- react-router 7 framework mode: imports from `react-router`; file-based route emission (1:1 with page declarations); loaders return raw objects (no `json()`); Vite plugin in `vite.config.hbs`.
- TS 6 tsconfig: explicit `"types": []`, `"module": "esnext"`, `"target": "es2025"`, `"moduleResolution": "bundler"`, `"esModuleInterop": true`.

## Phase 2 — backend / runtime version bumps (no architecture change)

Inline string bumps:

| target | files | change |
| --- | --- | --- |
| Hono | `src/generator/typescript/index.ts:204-216` | hono ^4.6→^4.12; drizzle-orm ^0.36→^0.45; drizzle-kit latest; @hono/zod-openapi same-major; pg latest; zod ^4 |
| .NET | `src/generator/dotnet/templates/program.tpl.ts:325-360` | Defer past 2026-11 (.NET 8 LTS). Then 8.0.10→10.0.x with FluentValidation 11.10→12.1, MediatR 2.1.7→14.1 |
| Phoenix | `src/generator/phoenix-live-view/index.ts:600` | phoenix `~> 1.7`→`~> 1.8`; **tighten `postgrex: ">= 0.0.0"`→`~> 0.20`** (pre-existing esm.sh-style trap); ash patches |

Wire each into a centralised `BACKEND_PINS` const per generator so deps management is one diff in one place.

## Phase 3 — deprecation policy

Once a new pack version has been live for a release cycle:
1. `BUILTIN_PACK_LATEST` already flipped in its 1.X PR — bareword consumers rolled forward automatically.
2. Validator emits `hint`-level diagnostic on bareword usage (only when there's more than one version of that family available) suggesting an explicit pin.
3. After two more cycles, archive old versions to `designs/_archive/<family>/<vN>/` (still loadable for legacy projects) or delete with a release note.

## Critical files

- `src/generator/_packs/builtin-formats.ts` — version maps + `parseBuiltinDesignRef` helper.
- `src/generator/_packs/loader-fs.ts:60` — `resolvePackDir` (Node).
- `web/src/build/loader-vfs.ts:77` — `resolvePackDir` (browser VFS); delete the hardcoded set at line 35.
- `web/src/build/template-bundled.ts` — glob + path-extract for the version axis.
- `src/generator/_packs/loader.ts` — `PackManifest.version` jsdoc + manifest/dir cross-check.
- `src/language/ddd-validator.ts:421-463` — version-aware Rule 14.
- `src/ir/lower.ts:475-495` — `qualifyDesign` helper, fully-qualified IR invariant.
- `src/ir/loom-ir.ts:707` — IR field jsdoc.
- `src/generator/react/index.ts:106-107` — generator dispatch defensive default.
- `test/generated-react-build.test.ts:74-75` — pack matrix expansion.
- `test/validation.test.ts:547` — new validator tests.

## Verification

**Phase 0:**
- `npm run langium:generate && npm run build && npm test` clean.
- `LOOM_TS_BUILD=1 npx vitest run test/generated-build.test.ts` clean (backend output unchanged).
- `LOOM_REACT_BUILD=1 npx vitest run test/generated-react-build.test.ts` clean (TSX output unchanged at 28 cases).
- `diff -r` of `bin/cli.js generate system examples/acme.ddd -o /tmp/before` vs `/tmp/after` — byte-identical.
- Playground sanity: pinning a storybook example to `design: "mantine@v7"` produces identical generated files to the bareword form; `design: "mantine@v999"` shows the version-listing error in the Problems panel.

**Each Phase 1.X PR:**
- New `LOOM_REACT_BUILD_CASE=…:<family>@<vN>` shard added; `tsc --noEmit` against the generated project passes.
- Pinned storybook variant compiles + bundles + boots end-to-end (extend `runtime.spec.ts` or `preview-shadcn.spec.ts` template).
- `npm test` clean across all suites.
- Visual diff against the previous version's storybook is reviewed manually (expected non-empty — UI lib upgrades change visual output).

**Phase 2:**
- `LOOM_TS_BUILD=1` runs full `tsc --noEmit` against emitted Hono projects with the new drizzle/zod versions.
- `LOOM_PHOENIX_BUILD=1 npx vitest run test/generated-phoenix-build.test.ts` runs `mix compile --warnings-as-errors` against Ash 3.24 / Phoenix 1.8 in the Elixir docker image.

## Lessons learned (Phase 0 + 1.2)

Each row is a thing the next Phase 1.X PR should avoid repeating. The
intent is to keep them at the bottom of this plan so they stay
visible — when adding a pack version, skim this section before
writing any code.

### 1. `tsc --noEmit` ≠ "it works"

The original CI shard only ran `npx tsc --noEmit` against the
generated TSX. That accepted v7-style `import ReactDOM from
"react-dom/client"; ReactDOM.createRoot(...)` under React 19 (the
default-import is type-shaped as a namespace) — and the bundle
exploded at runtime with `TypeError: ReactDOM.createRoot is not a
function`.

PR #149 added `npx vite build` to every shard so the production
bundling step gates the new versions. ~5 s extra per shard, well
worth it. **Future pack PRs should not skip this gate** — if
`vite build` doesn't run, runtime-only regressions slip through.

### 2. Audit the pack against the migration guide BEFORE rewriting

For mantine@v9 the audit found we use none of the v9-deprecated
APIs (`Text color`, `Grid gutter`, `Collapse in`, `useFullscreen`,
`@mantine/dates` Date-object components). Result: template changes
were essentially nil; just `package-json.hbs` deps.

Without that audit I would have wasted hours hand-applying prop
renames that didn't apply. Standard workflow per pack:

```bash
# After git mv-ing the existing pack into the new vN/ dir:
cd designs/<family>/<vNew>
grep -lE '<oldProp1>|<oldProp2>' *.hbs    # what does the pack ACTUALLY use?
# Then cross-reference the migration guide.
```

### 3. Don't conflate "ship vN" with "flip the default"

`BUILTIN_PACK_LATEST.mantine` flipping from v7 to v9 changes the
output of every bareword `design: mantine` source. The byte-equivalence
fixture at `test/fixtures/baseline-output/` will fail until refreshed.

These are two separable acts. Phase 1.X PRs ship the new pack as
opt-in (default unchanged). A follow-up "promote vN to default" PR
flips the map and refreshes the fixture in one go.

### 4. The default-import idiom doesn't survive React 18 → 19

`import ReactDOM from "react-dom/client"` only works in React 18
because the bundle plugin's `react-dom/client` shim provides a
default export. React 19's real `react-dom/client` only exposes
named exports. **Always emit `import { createRoot } from "react-dom/client"`**
in any new pack's `main.hbs`. (Old `mantine@v7` keeps the legacy
form because it still works under React 18 and we don't want to
churn v7-pinned bundles.)

### 5. esm.sh peerDep resolution can pull versions you didn't ask for

`@chakra-ui/icons@2.2.6` declared
`peerDependency: { "@chakra-ui/react": ">=2.0.0" }`. esm.sh resolved
that to v3 transitively, ignoring our package.json's pin to v2.
PR #146 fixed the symptom (dropped the icons dep). The general
lesson: when a transitive peer-dep range is loose, esm.sh picks
"latest matching" — which may be a future major. New pack versions
should either avoid such packages or pin them tighter via direct
deps when possible.
