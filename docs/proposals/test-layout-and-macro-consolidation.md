# Proposal — Reorganize tests and consolidate the macro pipeline

> Status: **SHIPPED.** The `test/` tree now mirrors the `src/` pipeline
> phases — `test/generator/` is subdivided per backend
> (`typescript/`, `dotnet/`, `react/`, `phoenix/`) plus `_walker/` /
> `_packs/` / `_obs/`; LSP tests live under `test/language/lsp/`; the
> macro subsystem is consolidated under `src/macros/`
> (`expander.ts` / `registry.ts` / `api/` / `stdlib/`). The layout this
> proposal argued for is the layout on main — see `CLAUDE.md`'s
> repository-layout table. The original target text is retained below
> for context.

## Context

`CLAUDE.md` is unambiguous about the compiler's layering:

```
language/  →  ir/  →  generator/<plat>/  →  system/
```

The **`src/` tree already mirrors this.** The **`test/` tree does not**, and
a chunk of the macro subsystem sits on the wrong side of the language /
IR boundary. Concretely:

- **`test/generator/` is a flat dump of 63 files** mixing four backends
  (TS / .NET / React / Phoenix), 33 walker-primitive tests, pack-rendering
  plumbing, and observability — even though `src/generator/` is cleanly
  subdivided into `typescript/`, `dotnet/`, `react/`, `phoenix-live-view/`,
  `_walker/`, `_packs/`, `_obs/`.
- **`test/system/` (24 files)** mixes real orchestrator tests with
  DSL-feature tests that merely happen to be *parsed inside* a
  `system { }` block (`system-emit-event`, `system-fields`,
  `system-find-params`, `system-expr`, `system-rename`, `system-add`,
  `system-body`, `system-model`). Those belong with IR feature tests.
- **`test/language/` (31 files)** interleaves 9 LSP tests with parsing /
  validation / type-system / print tests.
- **`test/macro/` (10 files)** has three misplaced tests:
  `with-clause-parsing` (language), `ir-capabilities` +
  `source-capabilities` (IR), `generator-dotnet-capability`
  (generator/.NET).
- **Macro infrastructure is scattered on the src side** across
  `src/language/ddd-macro-expander.ts`, `src/language/macro-registry.ts`,
  `src/macro-api/`, and `src/stdlib/`. (Note: `src/ir/walker-primitive-expander.ts`
  is **not** part of this — it is a post-IR lowering pass with zero
  coupling to the registry/expander, and stays where it is.)

**Outcome we want:** `test/` becomes a 1:1 map onto the pipeline, and
the macro AST-rewrite phase lives in one place (`src/macros/`).

This document is the target. The migration is a `git mv` exercise plus
a small, mechanical import-path sweep — no logic change anywhere.

---

## Part A — Test reorganization (pure `git mv`)

All moves use `git mv` so history is preserved. No file contents change;
no test logic changes. Vitest's `include: "test/**/*.test.ts"` already
covers the new nested paths, so `vitest.config.ts` needs no edit.

### test/language/ — split LSP out

```
test/language/lsp/        ← lsp-{code-actions, completion, definition, hover,
                            references, rename, semantic-tokens, signature-help,
                            workspace-symbols}.test.ts
test/language/parsing/    ← parsing, multifile-grammar, multifile-project,
                            primitive-conversion, implicit-string-concat,
                            spike-ast-pass1, textmate-grammar
test/language/print/      ← print-roundtrip, print-structural-roundtrip,
                            field-access-print-roundtrip,
                            sensitivity-print-roundtrip,
                            field-access-soft-keyword
test/language/type-system/← type-system-members, money-type-system,
                            money-literal-promotion,
                            general-literal-promotion, money-validator
test/language/validation/ ← validation, sensitivity, sensitivity-warnings,
                            binary-operand-validator, display-inspect-derived
```

### test/macro/ — keep only true macro tests

Move out:
- `with-clause-parsing.test.ts` → `test/language/parsing/`
- `ir-capabilities.test.ts`, `source-capabilities.test.ts` → `test/ir/capabilities/`
- `generator-dotnet-capability.test.ts` → `test/generator/dotnet/capability.test.ts`

Stays: `expansion`, `crudish`, `scaffold-equivalence`,
`factories-create-fields`, `unfold-action`, `capability-printer-roundtrip`.

### test/ir/ — group wire + capabilities

```
test/ir/wire/         ← wire-projection, wire-shape, wire-spec  (+ __snapshots__/)
test/ir/capabilities/ ← ir-capabilities, source-capabilities (from test/macro/)
```

The rest of `test/ir/` stays flat — `lower`, `page-ir`, `properties`,
`access`, `audited`, `sensitivity-lowering`, `style-lowering`,
`provenance`, `invariant-classify`, `enrichments`, `migrations-builder`,
`multifile-validate`.

### test/system/ — split orchestrator vs DSL feature

Move to **`test/ir/feature/`** (these test DSL features lowered inside a
`system { }` block; they are not orchestrator tests):
`system-emit-event`, `system-fields`, `system-find-params`,
`system-expr`, `system-rename`, `system-add`, `system-body`,
`system-model`.

Keep in `test/system/` (true orchestrator/composition):
`architecture-c4`, `architecture-integration`,
`acme-explicit-architecture`, `deployable-composition`,
`system-deployable-bindings`, `system-edge-rebind`, `system-rebind`,
`storage-declaration`, `api-binding-validation`, `system-infra-props`,
`system-diagram`, `system-grouped-layout`, `system-positions`,
`traceability`, `multifile-regression`, `system.test.ts`.

### test/generator/ — biggest single win: split by backend

```
test/generator/_walker/    ← builder-page-model, builder-splice,
                             recursive-layout-walker, stack-router-seam,
                             page-emitter-equivalence
test/generator/_packs/     ← template-partials, template-shared-layer,
                             menu-emitter, menu-page-meta,
                             button-navigation, state-fields, typed-page-params,
                             money-emission, join-table, order-explicit-equivalence
test/generator/_obs/       ← log-events-catalog
test/generator/typescript/ ← generator-ts, typescript-access-modifiers,
                             typescript-migrations-emit
test/generator/dotnet/     ← generator-dotnet, dotnet-access-modifiers,
                             dotnet-migrations-emit, capability (from macro/)
test/generator/react/      ← generator-react, react-access-modifiers,
                             all 33 walker-*.test.ts
test/generator/phoenix/    ← phoenix-action, phoenix-access-modifiers,
                             phoenix-e2e-dispatch, phoenix-live-view-pipeline,
                             phoenix-migrations-emit, phoenix-user-components
```

### test/system-v2/ — rename to surface intent

`system-v2/` actually runs against `web/src/` and is the playground-side
rewrite of the system builder. Rename to
**`test/playground/system-builder/`** to colocate with the rest of the
playground tests. Five files, no logic change.

### Unchanged

`test/platform/`, `test/playground/` (gains `system-builder/`),
`test/e2e/`, `test/cli/`, `test/conformance/`, `test/util/`,
`test/_helpers/`, `test/__snapshots__/`, `test/fixtures/`.

### Import impact for tests

Every test imports its helper as `"../_helpers/index.js"` (or
`"../_helpers/parse.js"`, etc.). Files moving from `test/<dir>/foo.test.ts`
to `test/<dir>/<subdir>/foo.test.ts` need one extra `..` segment in those
imports. Mechanical sweep; covered by a single `sed` over the moved
paths.

---

## Part B — Consolidate the macro pipeline to `src/macros/`

The macro subsystem is a clean lift — macro code already only depends on
`language/generated/ast.js` (read-only types) and `util/`. Nothing in
`ir/`, `cli/`, `generator/`, or `system/` imports from the macro
subsystem, so there is no downstream import churn.

### Target layout

```
src/macros/
├── expander.ts                  ← from src/language/ddd-macro-expander.ts
├── registry.ts                  ← from src/language/macro-registry.ts
├── index.ts                     ← new: re-exports + loadStdlibMacros() boot helper
├── api/
│   ├── define.ts                ← from src/macro-api/define.ts
│   ├── factories.ts             ← from src/macro-api/factories.ts
│   ├── factories-internals.ts   ← from src/macro-api/factories-internals.ts
│   ├── ui-factories.ts          ← from src/macro-api/ui-factories.ts
│   └── index.ts                 ← from src/macro-api/index.ts
└── stdlib/                       ← from src/stdlib/  (verbatim subtree)
    ├── index.ts
    ├── crudish.macro.ts
    ├── scaffold/  (scaffold.macro.ts + scaffold{Module,Context,Aggregate,
    │              View,Workflow}.macro.ts + _pages.ts)
    ├── audit/     (audit / auditable / auditedByDefault .macro.ts)
    └── softDelete/ (softDelete / softDeletable / softDeleteByDefault .macro.ts)
```

**Stays put** (do **not** move):
- `src/ir/walker-primitive-expander.ts` — IR lowering pass, not a macro.
  Zero coupling to the registry/expander.
- `src/language/lsp/unfold-macro.ts` — LSP code action; stays in
  `language/lsp/` but its imports rewrite.

### Import rewrites (only these files change content)

1. `src/macros/expander.ts` (was `ddd-macro-expander.ts`)
   - `./macro-registry` → `./registry`
   - `../macro-api/factories` → `./api/factories`
   - `../stdlib/index` → `./stdlib/index`
   - `./generated/ast` → `../language/generated/ast`
2. `src/macros/registry.ts` — no import changes (pure data container).
3. `src/macros/api/*` — rewrite `../language/generated/ast` →
   `../../language/generated/ast`. `./factories-internals` unchanged.
4. `src/macros/stdlib/**/*.macro.ts` — rewrite `../macro-api/index` →
   `../api/index` (and `../macro-api/ui-factories` →
   `../api/ui-factories` where used).
5. `src/macros/stdlib/index.ts` — rewrite `../language/macro-registry` →
   `../registry`.
6. `src/language/ddd-module.ts` — `./ddd-macro-expander` →
   `../macros/expander` (or `../macros/index` once we extract the boot
   helper).
7. `src/language/ddd-validator.ts` — `./ddd-macro-expander` →
   `../macros/expander`.
8. `src/language/lsp/unfold-macro.ts`:
   - `../ddd-macro-expander` → `../../macros/expander`
   - `../macro-registry` → `../../macros/registry`
   - `../../macro-api/define` → `../../macros/api/define`

### One architectural fix while we're here

`expander.ts` currently calls `loadStdlibMacros()` from `stdlib/index.ts`
at registration time, creating a `macros/expander → macros/stdlib`
coupling. Extract the boot call into a new `src/macros/index.ts` and
have `src/language/ddd-module.ts` invoke it during module init. This
keeps `expander.ts` agnostic of which macro libraries exist, and makes
the eventual user-defined-macro path symmetric (any caller can
`registerMacro(...)` without going through stdlib).

### tsconfig / package.json

`tsconfig.json` uses `"include": ["src/**/*.ts"]` and there are no path
aliases pointing at `macro-api` or `stdlib`. `package.json` exports / bin
do not reference these paths. **No config edits needed.**

---

## Why this is safe

- **`git mv` preserves history.** Every moved test and every moved
  source file still blames cleanly through the rename.
- **No test logic changes.** The default `npm test` suite — and every
  opt-in `LOOM_*` suite — runs the same assertions on the same code.
- **Layering improves, never regresses.** Every move strengthens the
  one-directional rule (`language → ir → generator → system`); no move
  introduces a back-edge.
- **No external API surface changes.** Nothing in `bin/`, `package.json`,
  or the public CLI behaviour is affected. The playground and the VS Code
  extension import from compiled `src/` paths that are unchanged (only
  `language/ddd-macro-expander` and `language/macro-registry` move, and
  nothing outside the compiler imports those).
- **The walker confusion is resolved by *not* moving anything.**
  `src/ir/walker-primitive-expander.ts` is an IR pass and stays in
  `src/ir/`; this proposal explicitly calls that out so a future reader
  doesn't conflate it with the macro registry.

## Execution order (when implemented)

1. **Part A first** (test moves only): low risk, no import edits beyond
   `_helpers` path depth.
2. Run `npm test` to confirm green.
3. **Part B**: `git mv` the four src subtrees, then sweep imports per the
   list above. Keep changes atomic per file where possible.
4. Run `npm run langium:generate && npm run build && npm test`.

## Verification

```bash
# After Part A
npm test                       # vitest default suite — should be green

# After Part B
npm run langium:generate       # ensure generated/ is fresh
npm run build                  # tsc -b must pass with new paths
npm test                       # same set of tests still green

# Smoke the macro path specifically
npx vitest run test/macro
npx vitest run test/language/parsing/with-clause-parsing.test.ts
npx vitest run test/generator/dotnet/capability.test.ts

# Smoke a generator end-to-end to confirm macro expansion still wired
node bin/cli.js generate system examples/acme.ddd -o /tmp/loom-out --dry-run | head -40

# Opt-in build, to confirm emitted TS still typechecks after the macro
# consolidation
LOOM_TS_BUILD=1 npm run test:tsc
```

If any of the above fails after Part B, the failure is almost certainly
an import path that wasn't rewritten —
`rg "macro-api|ddd-macro-expander|macro-registry|src/stdlib" src/`
should return zero results when the sweep is complete.

## Open questions

- **Do we want `test/generator/react/walker/`** as a further sub-split of
  the 33 walker tests? They share a tight contract (one primitive per
  file), but 33 in a flat `react/` directory may itself become unwieldy
  in another year. Punt unless the count grows.
- **Should `test/ir/feature/` be flat or grouped by feature family?**
  (e.g. `events/`, `find/`, `fields/`). Start flat; revisit if the
  count climbs past ~20.
- **Does the playground really want its system-builder tests folded in,
  or kept as their own top-level dir?** This proposal folds them in,
  but a separate `test/playground-system-builder/` is also defensible.
