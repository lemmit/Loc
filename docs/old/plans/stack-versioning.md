# Stack versioning (historical design note)

> **Reference moved.** The factual surface (what a stack is, how a
> pack picks one, the v1/v2/v3 catalogue, validation rules) is now in
> the reference doc [`design-packs.md § 2a`](../../design-packs.md#2a-stacks-and-how-a-pack-picks-one).
> The recipe for adding a new pack version is in the same doc.  This
> file is kept as the historical design note covering bundler-side
> wiring and the backend-stacks-vs-backend-packages comparison that
> isn't relevant to the user-facing authoring guide.
>
> Companion plan docs in this directory:
> [`pack-versioning-plan.md`](./pack-versioning-plan.md) (overall plan + lessons),
> [`per-pack-migration.md`](./per-pack-migration.md) (per-pack scope).
> The version audit moved to [`../audits/stack-versions-audit.md`](../../audits/stack-versions-audit.md).

## What a stack is

A **stack** is the cross-cutting framework baseline a pack ships
against. It owns the deps that aren't specific to any one design
system: React + React-DOM, the router, validation library, build
tooling. The pack on top contributes only what's design-specific:
the Mantine components, the Tailwind config, the Chakra theme.

Two axes:

- **design pack** = the UI library + its conventions (e.g. `mantine`,
  `chakra`, `shadcn`, `mui`). Versioned per-major: `mantine@v7`,
  `mantine@v9`.
- **stack** = the framework baseline the pack runs on. Today:
  - `v1` — React 18 + RR 6 + zod 3 + TS 5.7 + Vite 5
  - `v2` — React 19 + RR 6 + zod 3 + TS 5.7 + Vite 5
  - `v3` — React 19 + **RR 7** + **zod 4** (+ `@hookform/resolvers` 5)
    + TS 5.7 + Vite 5

  `v3` is the cutting-edge base. It is a *separate* base, not a
  mutation of v2: existing packs stay on v2 and a pack opts into v3
  by declaring `stack: "v3"` (then verified by its per-pack
  `LOOM_REACT_BUILD_CASE` shard + runtime e2e — same gate
  chakra@v3/mui@v7/shadcn@v4 went through). No per-lib axis split:
  React/router/zod move together in practice, so splitting them
  would multiply the compat matrix for combinations nobody ships.

  **Router 7 is not a pure dep pin.** RR 7 renamed the npm package
  `react-router-dom` → `react-router` (library mode keeps the v6
  API, so only the import specifier changes — framework mode is a
  separate, larger initiative, deliberately *not* in this base).
  That rename leaks into emitted source, so it's centralised in
  `src/generator/_packs/stack-runtime.ts` (`routerPackageForStack`),
  read by both emission paths: pack shell templates
  (`main.hbs`/`app-shell.hbs` via the `{{routerPackage}}` Handlebars
  var injected in `render.ts`) and the page body-walker. Defaults to
  `react-router-dom` for every pre-v3 / custom pack → byte-identical
  output until a pack actually adopts v3.

Packs declare their stack in `pack.json`. They aren't free
combinations — `chakra@v3` requires React 19, so it would declare
`stack: "v2"`. The validator + loader enforce that the combination
makes sense (loader throws if the declared stack directory doesn't
exist).

## How packs reference stacks

```
designs/
  mantine/
    v7/
      pack.json   { "name": "mantine", "version": "v7", "stack": "v1", ... }
      package-json.hbs                    # @mantine/* deps + {{> stack-package-deps}}
      ...
    v9/
      pack.json   { "name": "mantine", "version": "v9", "stack": "v2", ... }
      ...

stacks/
  v1/
    stack.json                            # id + deps summary + bundler hints
    stack-package-deps.hbs                # react / react-dom / RR / zod / dayjs / RHF
    stack-package-devdeps.hbs             # @types/react*, vite, TS, plugin-react
  v2/
    stack.json
    stack-package-deps.hbs                # React 19 versions of the above
    stack-package-devdeps.hbs
```

At generation time, the pack loader reads `pack.stack`, walks
`stacks/<id>/`, and registers every `.hbs` it finds there as a
Handlebars partial. The pack's `package-json.hbs` then pulls them
in:

```handlebars
"dependencies": {
{{> stack-package-deps}},
    "@mantine/core": "^9.2.0",
    ...
}
```

Pack templates override stack templates on collision (same name).
The shared cross-pack templates under `vite/`, `api/`, `docker/`
still apply on top of both.

## How the bundler uses stack identity

The playground bundler ships React projects to the iframe preview.
React 18 and React 19 require different bundling strategies — see
the lessons-learned section in
[`pack-versioning-plan.md`](./pack-versioning-plan.md). PR #154
(Phase 0.5 PR B) moved the per-stack policy into
`web/src/bundle/stacks.ts`:

```ts
export interface StackBundlerHints {
  id: string;
  externalReactRuntime: boolean;
  importmapReactDomQuery: (reactRange: string) => string;
  rdcShim: boolean;
}

export const STACKS: Record<string, StackBundlerHints> = {
  v1: { id: "v1", externalReactRuntime: true,  rdcShim: true,  importmapReactDomQuery: ... },
  v2: { id: "v2", externalReactRuntime: false, rdcShim: false, importmapReactDomQuery: ... },
};
```

`stackHintsForReactMajor(reactRange)` reads the React pin out of the
emitted `package.json` and returns the right policy. The bundler
plugin and the iframe importmap both consult the same module —
single source of truth.

**Why TS module rather than reading `stacks/<id>/stack.json` at
runtime:** the bundle plugin runs against a generated project that
doesn't ship `stacks/`. The bundler can't read the stack manifest at
bundle time; it can only inspect the emitted code. So
`web/src/bundle/stacks.ts` mirrors the bundler-relevant subset of
each stack's `stack.json` in code that's compiled into the
playground worker. When a new stack lands, both files update
together — same PR, same review.

## Adding a new frontend stack

Use this when a *cross-cutting* framework upgrade (React major,
react-router major, Vite major, TS major, zod major) demands a
clean break that existing pack versions shouldn't be forced
through.

1. Create `stacks/<id>/` (e.g. `stacks/v3/`) with:
   - `stack.json` — metadata + bundler hints (informational; the TS
     module is authoritative for the bundler).
   - `stack-package-deps.hbs` — the dep list as a Handlebars partial.
   - `stack-package-devdeps.hbs` — devDeps partial.
2. Add a row to `STACKS` in `web/src/bundle/stacks.ts` if the bundler
   needs to behave differently for this stack (React major different
   from existing stacks, new module-resolution quirk to handle, etc).
   Otherwise it inherits the closest-match defaults from
   `stackHintsForReactMajor`.
3. New pack versions that target this stack get `"stack": "<id>"` in
   their manifest.

The shared `vite/`, `api/`, `docker/` template trees stay
stack-agnostic. If a stack needs a different Vite config (e.g.
React Router 7 framework mode + `@react-router/dev` plugin) that
template should move into the stack directory, named so a pack
template can shadow it if it must.

## Backend stacks (Phase 2)

> **⚠️ Superseded.** This `stacks/<backend>` design is **not** the
> chosen direction — backends are versioned *code* packages, not
> dep bundles. See [`backend-packages.md`](./backend-packages.md)
> for the adopted model (versioned `PlatformSurface` packages:
> target-IR shaping + final lowering + templating per major,
> registry keyed `family@version`). The text below is kept only
> for historical context.

The mechanism generalises to backends. .NET, Hono, and Phoenix
each have a framework baseline that today is hardcoded in
`src/generator/<platform>/...`. Moving those into `stacks/` gives
the same shape:

```
stacks/
  v1/          (React 18 frontend stack)
  v2/          (React 19 frontend stack)
  hono@v4/     (Hono 4.x backend stack — drizzle 0.45, @hono/zod-openapi, etc.)
  dotnet@v8/   (.NET 8 LTS backend stack — EF Core 8, MediatR 2, FluentValidation 11)
  dotnet@v10/  (.NET 10 backend stack — post-2026-11 follow-up)
  phoenix@v1/  (Phoenix 1.7 — plain Ecto/Phoenix)
  phoenix@v2/  (Phoenix 1.8 — plain Ecto/Phoenix)
```

> (Superseded: the Ash foundation was removed in 2026 — these Phoenix
> backend stacks were originally pinned to Ash 3.x; the generated backend
> is now plain Ecto/Phoenix.)

Backend stack templates carry the equivalent of `package-json` (or
`csproj`, or `mix.exs`) per platform. The dep version literals
currently inlined at:

- `src/generator/typescript/index.ts:204-216`
- `src/generator/dotnet/emit/program.ts:325-360`
- `src/generator/phoenix-live-view/index.ts:600`

would move into `stacks/<id>/`. The generator looks up the
deployable's stack and merges the partials in the same way the
frontend packs do.

**DSL.** Two options for declaring a backend stack:

- **Quoted-platform pin** (mirrors how design packs work today):
  `platform: "dotnet@v8"`. Requires extending the `Platform` rule
  in `ddd.langium` to accept `STRING` as a fall-through alternative.
- **Separate `stack:` slot on the deployable**: `platform: dotnet,
  stack: "v8"`. Smaller grammar change but introduces a new
  deployable field.

Open question, decided when Phase 2 starts. The quoted-platform
form is preferred for symmetry with `design: "mantine@v9"`.

**Bareword default.** Just like packs, the bareword `platform: dotnet`
resolves to the toolchain's "current default" stack for that
family (e.g. `dotnet@v8` while .NET 8 is LTS; `dotnet@v10` after
the LTS rolls forward). The default lives in a registry analogous
to `BUILTIN_PACK_LATEST`.

**Bundler hints do not apply.** `web/src/bundle/stacks.ts` is
specific to the playground's in-browser bundling of React
frontends. Backend stacks need only the template-partial half
(deps + project structure). No bundler-side wiring required when
adding a backend stack.

**Test surface.** Each backend stack gets a CI shard against its
build toolchain:

- Hono → existing `LOOM_TS_BUILD=1` covers it; expand the matrix to
  include `hono@v4` shards.
- Phoenix → `LOOM_PHOENIX_BUILD=1 npx vitest run test/generated-phoenix-build.test.ts`
  in the Elixir docker image; add a matrix dimension for stack id.
- .NET → not yet automated in CI; needs a `dotnet build` step
  comparable to the React TSX shard.

## Default resolution rules

- **Pack bareword (`design: mantine`)** resolves through
  `BUILTIN_PACK_LATEST[family]` → a specific `family@version`.
  Today: `mantine@v7`. Flipping the bareword to `v9` is a separate
  follow-up PR paired with refreshing
  `test/fixtures/baseline-output/`.
- **Stack bareword (`platform: dotnet`)**, once Phase 2 ships,
  resolves similarly through a `BUILTIN_STACK_LATEST` map (or
  per-platform field). The bareword always pins to the LTS-style
  default; cutting-edge users pin explicitly.

## Validation rules

The validator enforces:

- A pack's `stack` field must reference a registered stack
  directory (loader throws on missing).
- A pack-version's stack assignment is fixed in the manifest —
  users don't override it from the DSL.
- A deployable's `platform` (current keyword set) limits which
  design-pack formats are compatible (Rule 14 in
  `src/language/ddd-validator.ts`). Stack identity becomes a
  cross-cutting dimension that doesn't replace Rule 14 — it adds
  to it.

When `dotnet@v8` ships, Rule 14 grows a stack-compatibility check:
e.g. `mantine@v9` can't ride on `dotnet@v8`'s server-render path
because React 19's server-component support is still in flux.

## Stack vs pack — quick reference

| | Stack | Pack |
| --- | --- | --- |
| Scope | Cross-cutting framework baseline | UI library / runtime layer / templates |
| Directory | `stacks/<id>/` | `designs/<family>/<version>/` (frontend) <br> `src/generator/<platform>/` today, future `stacks/<id>/` for backends |
| DSL declaration | Pack/deployable references via manifest field | `design: "mantine@v9"` on the deployable |
| Default selection | `BUILTIN_PACK_LATEST` (packs); future `BUILTIN_STACK_LATEST` (stacks) | same |
| Bundler awareness | `web/src/bundle/stacks.ts` policy module | `BUILTIN_PACK_FORMATS` format map |
| Coexistence | Multiple stacks can live in the repo at once | Same — multiple pack versions side-by-side |
| Promotion | One PR flips the bareword default + refreshes fixtures | Same |