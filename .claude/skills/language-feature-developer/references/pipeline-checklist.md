# Pipeline checklist — files you touch to add a language feature

Loom compiles in **ten phases**, strictly one-directional
(`language → ir → generator → system`). A feature touches a *contiguous
slice* of these phases — figure out where your feature enters and where it
exits, then touch only those rows. The canonical deep dive is
`docs/technical.md`; this is the operational map.

```
.ddd → ① parse → ② macro expand → ③ scope/link → ④ AST validate → ⑤ lower
     → ⑥ enrich → ⑦ IR validate → ⑧ per-platform codegen → ⑨ system compose → ⑩ write
```

Targets: **5 backends** (TypeScript/Hono `node`, .NET, Phoenix vanilla Ecto
`elixir`, Python/FastAPI, Java/Spring) and **5 frontends** (React, Vue,
Svelte, Angular, Feliz — F#/Fable/Elmish; consumes the shared walker via
`src/generator/feliz/feliz-target.ts` but emits F#, not JSX, and uses
`.fsproj`+Fable, not the JS `stacks/` system or design packs). The two seams
that let one feature reach all backends:
`ExprTarget` (`src/generator/_expr/target.ts`) for expressions and
`WalkerTarget` (`src/generator/_walker/target.ts`) for JSX-/F#-family page
rendering. Phoenix HEEx runs a *parallel* walker engine
(`src/generator/elixir/heex-walker-core.ts`) — it is not driven by the
shared `walkBody`.

## The checklist, by phase

Touch a row only if the feature reaches that phase. The header on each row
tells you when it applies.

### ① Grammar — only if there is new surface syntax
- `src/language/ddd.langium` — add/extend the rule. Prefer a discriminator
  field (`kind=`/`op=`) over `{infer X.field=current}` actions (the latter
  generates recursive AST types that fail typecheck). Prefer flat-list rules
  (`head=ID ('.' tail+=ID)*`) over recursive ones. Use soft/contextual
  keywords for new words so you don't break existing identifiers.
- **Then run `npm run langium:generate` and commit** the regenerated
  `src/language/generated/{ast,grammar}.ts` (+ reflection). `langium-generated.yml`
  fails CI on any drift; never hand-edit these files.

### ② Macros — only if the feature is compile-time sugar
- `src/macros/stdlib/<feature>/…` (a new macro) and `src/macros/api/factories.ts`
  if macros must construct the new AST form. **Macros emit final AST, not
  sentinels** — build the complete expansion up front so `unfold` ejects real
  `.ddd` source. Before deferring expansion to a later pass, check whether that
  pass actually has information the macro lacks; usually it doesn't.

### ③ Scope — only if the feature adds cross-references
- `src/language/ddd-scope.ts` — resolve the new name references. Cross-aggregate
  references must spell out `X id` (the scope provider restricts bare type refs
  to same-aggregate entity parts; violations are `loom.bare-aggregate-in-type`).

### ④ AST validate — almost always
- `src/language/validators/<theme>.ts` — a new themed validator (new file for a
  new theme, or extend an existing one). Give every diagnostic a stable
  `loom.<kebab-code>`.
- `src/language/validators/index.ts` — re-export it.
- `src/language/ddd-validator.ts` — register it in the check list.
- `src/language/type-system.ts` — if the feature introduces new types or member
  typing.

### print — only if the feature adds a structural member / expr / stmt
- `src/language/print/print-structural.ts` (or `print-expr.ts` / `print-stmt.ts`)
  — add the matching `case`. **`print-completeness.test.ts` fails until you do**
  (it reflects over the grammar's printable unions).

### ⑤ Lower (`.ddd` AST → Loom IR) — almost always for semantic features
- `src/ir/types/loom-ir.ts` — the new IR node/field. Add to `wire-types.ts` if it
  affects the wire shape. **Derive, don't stamp**: store a fact only if the
  pipeline can't re-derive it from facts already on the node (page *kind* is the
  cautionary tale — it's classified on demand, never stamped).
- Lower it:
  - new `ExprIR.kind` / stmt / type → `src/ir/lower/lower-expr.ts` /
    `lower-stmt.ts` / `lower-types.ts`.
  - new structural member → the matching leaf
    `src/ir/lower/lower-{members,view,workflow,ui,deployment,requirements,capabilities}.ts`,
    then wire the call into the `lower.ts` orchestrator. Leaves never import
    `lower.ts` (the graph is acyclic).
- `src/ir/stdlib/<feature>.ts` — shared IR-construction helpers (optional).

### ⑥ Enrich — only if it feeds wireShape / auto-findAll / associations / migrationsOwner
- `src/ir/enrich/enrichments.ts` — extend the single pure derivation pass. The
  output is the branded `EnrichedLoomModel`; downstream takes only the enriched
  type, so an un-enriched IR fails to typecheck.

### ⑦ IR validate — almost always (cross-aggregate / capability / gating checks)
- `src/ir/validate/checks/{query,system,ui,structural,workflow,test}-checks.ts`
  — the gate logic. Shared predicate helpers go in `src/ir/util/<feature>-capability.ts`.
- `src/ir/validate/validate.ts` — register the check fn in `validateLoomModel`
  (often a 1-line wire; when a feature lands on one backend at a time, swap the
  generic gate for a backend-specific one as each backend gains support — the
  `#1442 → #1447/#1449` lifecycle-stamp pattern).

### ⑧ Per-platform generators — pick rows by what the feature *does*
- **New `ExprIR.kind`:** add ONE arm to `renderExprWith` and ONE method to the
  `ExprTarget` interface in `src/generator/_expr/target.ts`; the exhaustive
  switch makes every backend a compile error until you fill its leaf table
  (`TS_TARGET` / `CS_TARGET` / `ELIXIR_TARGET` / `PY_TARGET` / `JAVA_TARGET` in
  each backend's `render-expr.ts`). Frontends don't run domain logic — skip them.
- **New `StmtIR` kind:** extend each backend's `render-stmt.ts` (flat per-backend
  dispatch — deliberately *not* shared, the arms are shape-divergent).
- **Backend-specific emission** (persistence, stores, routes, stamps): the
  matching emitter — TS `src/generator/typescript/emit/*.ts` +
  `src/platform/hono/v4/{emit,routes-builder}.ts`; .NET `src/generator/dotnet/emit/*.ts`;
  Elixir `src/generator/elixir/{domain/*,*-emit}.ts` (+ `vanilla/*` for the
  vanilla Ecto foundation); Python `src/generator/python/emit/*.ts`; Java
  `src/generator/java/emit/*.ts`. Larger per-aggregate-variable content lives in
  a `*-builder.ts`.
- **New UI page primitive (React/Vue/Svelte):** register it in
  `src/generator/_walker/registry.ts` AND mirror the name in
  `src/language/walker-stdlib.ts` (**walker-stdlib-completeness.test.ts** gates
  the mirror). Framework seams go on `WalkerTarget` (`_walker/target.ts`),
  consumed by `react/walker/tsx-target.ts`, `vue/walker/vue-target.ts`,
  `svelte/walker/svelte-target.ts`. Write the Phoenix HEEx renderer in
  `src/generator/elixir/heex-target.ts` (+ `heex-walker-core.ts`), or pin the
  gap — **heex-parity.test.ts** freezes the set of TSX-only primitives.
  Framework-neutral pieces (zod schemas, page objects, the e2e harness) live in
  `src/generator/_frontend/`.
- **Optional framework-only seam** (e.g. Angular forms): add OPTIONAL `render*?`
  methods to `WalkerTarget`, optional `ctx.*` side-channels in `walker-core.ts`,
  delegate-first in the shared `primitives/*.ts`, then implement in that
  frontend's `walker/*-target.ts` + `page-shell.ts` + new `*-builder.ts`.
- **Design-pack output** (`.hbs`): under `designs/<pack>/` (Mantine/shadcn/mui/chakra
  for React, vuetify/shadcnVue for Vue, shadcnSvelte/flowbite for Svelte,
  angularMaterial for Angular, ashPhoenix for HEEx).

### ⑨ System / artifacts — only if the feature changes a TypeIR kind or migrations
- Each sibling of `src/system/index.ts` handles new TypeIR kinds in its `.loom/`
  artifact: `wire-spec.ts`, `mermaid.ts`, `loomsnap.ts`, `migrations-builder.ts`
  (derives `MigrationsIR`; the Postgres-SQL renderer it feeds is
  `src/generator/sql-pg.ts`), `traceability.ts`, `likec4.ts`.

### shared util — cross-layer helpers
- `src/util/naming.ts` (`pascal`/`camel`/`snake`/`plural`), `src/util/code-builder.ts`
  (`lines(...)` — the only way the backend emitters build source; no template
  engine), `src/util/principal.ts`. A helper lives at the **layer of its
  consumers** — never imported upward against the pipeline.

### web playground parity — if the feature changes the builder model surface
- `web/src/builder/system/{fields,model}.ts`.

### docs — always for a user-visible feature
- A per-feature `docs/<feature>.md`, or extend `docs/capabilities.md` /
  `docs/generators.md` (the per-backend matrix) / `docs/language.md`.

## Which targets a feature kind requires

| Feature kind | Backends | Frontends |
|---|---|---|
| New expr / stmt / type (domain logic) | all 5 (`render-expr`/`render-stmt`) | — |
| Wire-shape / payload | all 5 DTO emitters + `system/wire-spec.ts` | all 5 (consume `wireShape`) |
| Persistence / capability (stamps, soft-delete, stores) | per-backend emit; often one backend per PR, narrowing the `validate.ts` gate as each lands | — |
| UI page primitive | — | React/Vue/Svelte/Feliz via shared walker (Feliz emits F#) + Phoenix HEEx (separate); Angular via optional seams |
| Validate-only gate | none (just `ir/validate/checks/*` + `validate.ts`) | — |
| Backend codegen gap-fill | one backend's emitters only | — |

## Layering invariant (test-enforced)
`language → ir → generator → system` is one-directional;
`src/generator/<platform>/` knows nothing about other platforms; `system/`
composes, never generates domain code. **`pipeline-layering.test.ts`** fails on
any *runtime* backward edge (an `import type` of shared IR vocabulary is exempt —
it carries no runtime edge). **`backend-packages-layering.test.ts`** guards the
`generator → platform/<family>/<vN>` package edge. When a helper is shared
across layers, put it at the layer where its consumers live, never "upward".

## Working discipline
- **Re-sync before every slice and after every merge:** `git fetch origin main
  && git reset --hard origin/main` (or rebase the feature branch). `main` moves
  under you — a stale base makes you rebuild merged work *and* reason from
  behaviour that no longer exists.
- **Verify the feature isn't already shipped — on fresh `main`** — before
  building. Grep the actual grammar rules / validator gates / emitter arms and
  check open PRs. The code on fresh `main` beats your memory of it.
