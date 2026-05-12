# Adding a new pack version — recipe

Worked example: the steps that landed `mantine@v9` in PRs #148 + #149.
Use this as the per-PR checklist for every Phase 1.X pack upgrade.
The recipe is **deliberately mechanical** — most of the thinking
already happened upstream in
[`per-pack-migration.md`](./per-pack-migration.md) (what changes per
library) and [`stack-versions-audit.md`](./stack-versions-audit.md)
(which versions to target).

For the broader architecture, see
[`pack-versioning-plan.md`](./pack-versioning-plan.md).

---

## Step 1 — Audit before forking

Read the upstream migration guide(s) for the target pack. Then grep
the existing pack's templates for every deprecated/renamed API you
found. **Don't write the new pack until you know what actually
changes for our use** — see lessons-learned #2 in
`pack-versioning-plan.md`. The Mantine pack audit took ~10 minutes
and converted a "rewrite everything" problem into "bump deps only".

```bash
# Replace `<family>` and `<vOld>` with the target.
# Search for prop renames documented in the migration guide.
grep -nE 'color=|isOpen=|gutter=|in=|spacing=' designs/<family>/<vOld>/*.hbs

# Search for components that were renamed or removed.
grep -nE '<Divider|<Modal|<Drawer\b' designs/<family>/<vOld>/*.hbs

# Search for hooks whose signature changed.
grep -nE 'useToast|useDisclosure|useFullscreen' designs/<family>/<vOld>/*.hbs

# Search for upstream package imports that may have moved subpaths.
grep -nE "from \"@<family>/" designs/<family>/<vOld>/*.hbs
```

Each match is a row in your "template diff" worklist. **No match
= no template change needed** for that area; the migration is
package-json-only.

## Step 2 — Fork the directory

```bash
cp -r designs/<family>/<vOld> designs/<family>/<vNew>
# Bump the manifest's `version` field to match the directory.
sed -i 's/"version": "<vOld>"/"version": "<vNew>"/' \
  designs/<family>/<vNew>/pack.json
```

`pack.json`'s `version` is load-bearing — the loader cross-checks it
against the parent directory name and throws on mismatch (PR #147
machinery). The cross-check catches copy-paste forks that leave the
manifest stale.

## Step 3 — Update `package-json.hbs`

Every Phase 1.X new pack version targets the **cross-cutting
baseline** from
[`per-pack-migration.md`](./per-pack-migration.md#cross-cutting-baseline-applies-to-every-new-pack-version):

```
"react":              "^19.2.0",
"react-dom":          "^19.2.0",
"react-router":       "^7.0.0",    (NB: package renamed from react-router-dom)
"vite":               "^8.0.0",
"typescript":         "^6.0.0",
"zod":                "^4.0.0",
"@hookform/resolvers":"^5.0.0",
"framer-motion":      "^12.0.0",    (if pack uses it)
"lucide-react":       "^1.0.0",     (if pack uses it)
"@types/react":       "^19.2.0",
"@types/react-dom":   "^19.2.0",
"@vitejs/plugin-react":"^4.3.0",
```

Plus the pack-specific deps at their new majors:

- mantine: `@mantine/core` / `@mantine/hooks` / `@mantine/notifications` / `@mantine/modals` / `@mantine/dates` → `^9.2.0`
- mui: `@mui/material` / `@mui/icons-material` → `^7.0.0`
- chakra: `@chakra-ui/react` → `^3.x.0` plus `next-themes`
- shadcn (with tailwind 4): `tailwindcss` → `^4.x`, `@tailwindcss/postcss` (new), drop `tailwindcss-animate`

Reference table: [`stack-versions-audit.md`](./stack-versions-audit.md).

## Step 4 — Apply template changes

For each row in your Step-1 worklist, edit the templates. The
mechanical pieces (boolean prop renames, component renames) are
amenable to `sed -i` or the upstream codemod (chakra/mui ship them).
Compound-component restructuring (Chakra v3) is hand-work.

**Always emit named-import `createRoot` in `main.hbs`** (PR #149
lesson):

```tsx
// CORRECT — works under both React 18 and 19:
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<App />);

// WRONG under React 19 — type-checks but explodes at runtime:
import ReactDOM from "react-dom/client";
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

## Step 5 — Register the new version

Add the qualified name to `src/generator/_packs/builtin-formats.ts`:

```ts
export const BUILTIN_PACK_FORMATS = {
  // ... existing entries ...
  "<family>@<vNew>": "tsx",  // or "heex" for ash-style packs
} as const satisfies Record<string, "tsx" | "heex">;
```

**Don't flip `BUILTIN_PACK_LATEST` in the same PR** — that's a
separate "promote" PR paired with refreshing the byte-equivalence
fixture under `test/fixtures/baseline-output/` (lessons-learned #3
in the plan).

```ts
// Leave it alone in your PR:
export const BUILTIN_PACK_LATEST = {
  ...,
  <family>: "<vOld>",  // unchanged
};
```

## Step 6 — Add the version to the test matrix

`test/generated-react-build.test.ts`:

```ts
const PACKS: readonly PackSpec[] = [
  // ... existing entries ...
  { family: "<family>", version: "<vNew>" },
];
```

`.github/workflows/generated-react-build.yml`:

```yaml
pack: ["mantine@v7", "mantine@v9", "shadcn@v3", ..., "<family>@<vNew>"]
```

## Step 7 — Add a pinned storybook example to the playground

So the in-browser dropdown can demo old + new side-by-side:

```bash
cp web/src/examples/storybook-<family>.ddd \
   web/src/examples/storybook-<family>-<vNew>.ddd
# Rewrite the `design:` slot to the pinned form.
sed -i 's/design: <family>/design: "<family>@<vNew>"/' \
  web/src/examples/storybook-<family>-<vNew>.ddd
```

Register it in `web/src/examples/index.ts`:

```ts
import storybook<Family><VNew>Source from "./storybook-<family>-<vNew>.ddd?raw";
// ...
{
  id: "storybook-<family>-<vNew>",
  label: "<Family> <N> · pinned storybook",
  source: storybook<Family><VNew>Source,
  blurb: "...",
},
```

## Step 8 — Verify

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

**The `vite build` step inside the shard is non-negotiable** —
PR #149 added it to catch class-shape mismatches `tsc --noEmit` lets
through (the React 19 default-import-of-`react-dom/client` regression
was the precipitating cause).

## Step 9 — Commit + PR

Title: `feat(packs): <family>@<vNew> — <one-line summary>`.

PR body checklist:

- [ ] Migration-guide URLs from `per-pack-migration.md`
- [ ] What template changes applied (per the Step-1 audit)
- [ ] `BUILTIN_PACK_LATEST` intentionally **not** flipped
- [ ] Test plan: `LOOM_REACT_BUILD_CASE=…:<family>@<vNew>` and
      `LOOM_REACT_BUILD_CASE=…:<family>@<vOld>` both green
- [ ] Note any follow-up needed (e.g. promote-to-default PR; visual
      diff review)

## Step 10 — Follow-up: promote to default

In a separate PR after the new version has soaked:

1. Flip `BUILTIN_PACK_LATEST.<family>` from `<vOld>` to `<vNew>` in
   `src/generator/_packs/builtin-formats.ts`.
2. Regenerate the byte-equivalence baseline:

   ```bash
   node scripts/capture-baseline-fixture.mjs
   ```

3. Update `test/loader-vfs.test.ts`'s bareword expectation:

   ```ts
   expect(resolvePackDir("<family>")).toBe("/designs/<family>/<vNew>");
   ```

4. Update this doc and `pack-versioning-plan.md`'s status tracker.

---

## Anti-patterns to avoid

| anti-pattern | why |
| --- | --- |
| Skipping `vite build` in CI to "save time" | PR #149's exact regression slips back in |
| Flipping `BUILTIN_PACK_LATEST` in the same PR as the new pack | byte-equivalence fixture goes stale; two unrelated changes in one diff |
| Keeping `forwardRef` wrappers / `<Context.Provider>` "for symmetry with v7" | new pack versions are clean breaks — no compat shims inside one pack |
| Adopting `react-router-dom` (v6 name) in new packs | v7 renamed to `react-router`; "no technical debt" rule from the plan |
| Letting `manifest.version` drift from the parent dir | loader throws on mismatch — fix at the source, don't disable the check |
