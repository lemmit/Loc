# Proposal — Reveal the IR pipeline phases in `src/ir/`

> Status: **SHIPPED.** `src/ir/` now reveals the pipeline phases as
> sibling directories: `types/` (the IR vocabulary), `lower/` (phase ⑤),
> `enrich/` (phase ⑥), `validate/` (phase ⑦), and `util/`;
> `migrations-builder.ts` moved out of `src/ir/` to `src/system/` (it
> runs at system-composition time, phase ⑨). `lower/` and `validate/`
> were further decomposed into per-declaration-kind / per-theme leaves
> (#921/#923/#930/#935 for lower; #900 for validate). The layout this
> proposal argued for is the layout on main — see `CLAUDE.md`'s
> repository-layout table. The original proposal text is retained below
> for context.
>
> Companion to [`test-layout-and-macro-consolidation.md`](./test-layout-and-macro-consolidation.md)
> (also SHIPPED) — that one made the *test tree* mirror the pipeline;
> this one did the same for the *IR source tree*.
>
> **Revision history**
> - **v2** — corrected `transform/` bucket (see "Correction" below); folded
>   `walker-primitive-expander.ts` into `lower/` because it actually runs as
>   the final sub-pass of `lowerModel`, not as a separate post-IR pass;
>   moved `migrations-builder.ts` out of `src/ir/` entirely (to `src/system/`)
>   because it runs at system composition time. Added the verified pipeline
>   map and references to the corrected `docs/technical.md`.

## Why this proposal exists

The pipeline as a sequence of named phases is well understood and matches
the rule in `CLAUDE.md` ("`language/` knows nothing about `ir/`, `ir/`
knows nothing about `generator/`, …"). But the **intra-`ir/` phase order
is invisible from the file tree**: lowering, IR data types, enrichment,
validation, and an in-lowering transform all sit at one depth, alongside
a derivation (`migrations-builder.ts`) that doesn't even run in the IR
phase. `ls src/ir/` shows ten files in alphabetical order with no clue
which run first or which the rest of the compiler consumes.

Below is the verified phase sequence the proposal aligns to. The
canonical, detailed version is in
[`docs/technical.md`](../../technical.md); this is the abbreviated
phase-by-phase view that motivates the file layout.

### The compiler pipeline (verified against the code)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Phase 1 — Parse                              src/language/generated/         │
│    .ddd text → AST (Langium-generated parser)                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 2 — AST macro expansion                src/macros/expander.ts          │
│    `with X(...)` clauses → synthesised members spliced into the AST           │
│    Runs on DocumentState.IndexedContent (before scope computation)            │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 3 — Scope + Link                       src/language/ddd-scope.ts       │
│    Langium linker resolves Reference<X> across the AST                        │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 4 — AST validation                     src/language/ddd-validator.ts   │
│                                               src/language/type-system.ts     │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 5 — LOWERING (AST → Loom IR)           src/ir/lower.ts                 │
│    Three intertwined sub-passes, all in `lowerModel`:                         │
│      5a  Structural walk                       src/ir/lower.ts                │
│      5b  Expression / name-resolution walk     src/ir/lower-expr.ts           │
│      5c  Inline scaffold expansion             src/ir/walker-primitive-       │
│            (rewrites scaffoldDetails/Operations           expander.ts         │
│             primitives in page bodies; called at                              │
│             the end of lowerModel — NOT a separate                            │
│             post-IR phase)                                                    │
│    Output: LoomModel (per file; multi-file merges via mergeLoomModels)        │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 6 — Enrichment                         src/ir/enrichments.ts           │
│    One pure pass: wireShape, auto-findAll, associations,                      │
│    react targets: module inheritance                                          │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 7 — IR validation                      src/ir/validate.ts              │
│    Cross-aggregate / multi-file checks needing the fully-resolved IR          │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 8 — System composition + migration     src/system/index.ts             │
│           derivation                                                          │
│    buildMigrations(sys, snapshots): IR diff → MigrationsIR[]                  │
│      (using src/ir/migrations-builder.ts — but called HERE, at system         │
│       composition time, not in the IR phase)                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 9 — Per-platform code generation       src/generator/<platform>/       │
│    Each backend reads IR.wireShape directly; backends that run                │
│    domain logic also walk ExprIR/StmtIR via render-expr/render-stmt           │
├───────────────────────────────────────────────────────────────────────────────┤
│  Phase 10 — Output writing                    src/cli/main.ts                 │
│    Map<path, content> → filesystem (with .loomignore filtering)               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**There is no target-backend IR.** Every backend consumes `LoomModel`
directly. The only secondary IR is `MigrationsIR`, produced once at system
time and shared across every backend that has a database.

### What this means for `src/ir/`

Five things actually live there:

```
src/ir/  (~9.7k lines)
  walker-primitive-expander.ts  1055   ← final sub-pass of Phase 5 (lowering)
  lower.ts                      1987   ┐ Phase 5 — AST → IR
  lower-expr.ts                 1439   ┘
  loom-ir.ts                    1615   ┐ IR data types
  migrations-ir.ts               113   ┘
  enrichments.ts                 766   ┐ Phase 6 — derivation
  wire-projection.ts              74   ┘
  validate.ts                   1697   ┐ Phase 7 — IR-level validation
  invariant-classify.ts          415   ┘
  migrations-builder.ts          465   ← used in Phase 8 (system composition)
  prov-id.ts                     105   utility (FNV-1a hashing)
```

Two of those (`walker-primitive-expander.ts` and `migrations-builder.ts`)
hide where they actually run.

## Proposal — phase-named subdirectories

```
src/ir/
├── types/
│   ├── loom-ir.ts              (the IR ADT — 126 importers)
│   └── migrations-ir.ts        (migration step ADT — 14 importers)
│
├── lower/                       # Phase 5 — AST → IR
│   ├── lower.ts                (structural walker; never descends into expressions)
│   ├── lower-expr.ts           (expressions, statements, name resolution, member typing)
│   └── walker-primitive-expander.ts  (inline scaffold expansion;
│                                       runs at the end of lowerModel)
│
├── enrich/                      # Phase 6 — one pure pass after lowering
│   ├── enrichments.ts          (wireShape, auto-findAll, associations, react targets)
│   └── wire-projection.ts      (helper used by enrichments + by system/wire-spec)
│
├── validate/                    # Phase 7 — post-lower validation
│   ├── validate.ts             (cross-aggregate / multi-file checks)
│   └── invariant-classify.ts   (classify invariant expressions by category)
│
└── util/
    └── prov-id.ts              (FNV-1a hash for provenance ids)
```

**Separately, in Part B of the same migration:**

```
src/system/
├── …existing files…
└── migrations-builder.ts        ← MOVED from src/ir/ (runs at Phase 8,
                                    not in the IR layer)
```

### Why this grouping

- **Phase-named subdirs, not file-type-named.** `lower/`, `enrich/`,
  `validate/` are the same words `CLAUDE.md` and `docs/technical.md`
  use. A new contributor's mental model of
  "lower → enrich → validate" lines up 1:1 with the file tree.
- **`types/` is what the rest of the compiler actually consumes.** 126
  files import from `loom-ir.ts`; only `lower/`, `enrich/`, and
  `validate/` import from each other. Putting the type ADT in its own
  subdir signals that distinction: *the rest of the compiler consumes
  `ir/types/`, not the passes.*
- **`walker-primitive-expander.ts` lives in `lower/`** because
  `lower.ts:537` calls `expandInlineScaffoldPrimitiveCalls(built)` as
  the last thing before returning the `LoomModel`. It's the final
  sub-pass of lowering, not a post-IR pass.
- **`migrations-builder.ts` leaves `src/ir/` entirely** because
  `src/system/index.ts:116` is the only call site — it derives
  `MigrationsIR[]` at system composition time from an already-built,
  already-enriched, already-validated `LoomModel`. Living in `src/ir/`
  misled the previous revision of this proposal into bucketing it as a
  "post-IR transform". It is a system-time derivation.
- **`enrichments.ts` and `wire-projection.ts` are a pair.** The
  enrichment pass produces `wireShape`; `wire-projection.ts` is the
  shared helper that `system/wire-spec.ts` also calls. They belong
  together.
- **`invariant-classify.ts` is part of validation.** It's used by
  `validate.ts` to bucket invariants by category.

### Correction relative to v1 of this proposal

v1 (merged in #584) proposed a `transform/` bucket containing
`walker-primitive-expander.ts` and `migrations-builder.ts`. That was
wrong on both counts:

| File | v1 placement | v2 placement | Why |
|---|---|---|---|
| `walker-primitive-expander.ts` | `src/ir/transform/` | `src/ir/lower/` | Called from inside `lowerModel` (lower.ts:537) as the final sub-pass of lowering, not a separate phase. |
| `migrations-builder.ts` | `src/ir/transform/` | `src/system/` | Called only from `src/system/index.ts:116` at system composition time (Phase 8), not in the IR phase. |

The `transform/` bucket therefore disappears entirely. v2's layout has
four phase subdirs (`types/`, `lower/`, `enrich/`, `validate/`) plus
`util/`, mirroring the four phases the IR layer actually runs.

### What this is *not*

- **Not a logic change.** Every file moves verbatim. The structural
  walker rule "`lower.ts` imports from `lower-expr.ts`, never the other
  way" is preserved.
- **Not a refactor of any phase.** The 1987-line `lower.ts` stays at
  1987 lines; we are not splitting it further in this proposal.
- **Not a new layering rule.** The existing rule
  (`language → ir → generator`) is unchanged; this proposal only adds
  *intra-`ir/`* phase visibility, plus moves one mis-located file out
  of `ir/`.

## Import impact

Total external importers of `src/ir/*.ts` files today (unchanged from v1):

| File                          | Importers | New home                          |
|-------------------------------|----------:|-----------------------------------|
| `loom-ir.ts`                  |       126 | `ir/types/loom-ir.ts`             |
| `enrichments.ts`              |        24 | `ir/enrich/enrichments.ts`        |
| `lower.ts`                    |        22 | `ir/lower/lower.ts`               |
| `migrations-ir.ts`            |        14 | `ir/types/migrations-ir.ts`       |
| `wire-projection.ts`          |         7 | `ir/enrich/wire-projection.ts`    |
| `prov-id.ts`                  |         6 | `ir/util/prov-id.ts`              |
| `validate.ts`                 |         6 | `ir/validate/validate.ts`         |
| `invariant-classify.ts`       |         6 | `ir/validate/invariant-classify.ts` |
| `migrations-builder.ts`       |         2 | **`system/migrations-builder.ts`**  |
| `lower-expr.ts`               |         1 | `ir/lower/lower-expr.ts`          |
| `walker-primitive-expander.ts`|         0 | `ir/lower/walker-primitive-expander.ts` |
| **Total**                     |   **214** |                                   |

214 import sites need rewriting. **All mechanical** — a single sweep per
file. `tsconfig.json` and `langium-config.json` need no edit. The
generated parser in `src/language/generated/` does not import from
`src/ir/` and is unaffected.

## Why this is safe

- **`git mv` preserves history.** Every file blames cleanly through
  the rename.
- **Diff is mechanical and reviewable.** Two kinds of change only:
  (a) `git mv` per file, (b) one import-path rewrite per importer.
- **No public API change.** Nothing in `bin/`, `package.json`, the CLI,
  the VS Code extension, or the playground depends on the *intra-IR*
  module layout.
- **The default `npm test` suite is the regression gate.** If imports
  resolve and `tsc` builds, the IR is observably unchanged.
- **Verifies one easy invariant after the move.**
  `rg "from ['\"][^'\"]*ir/(loom-ir|migrations-ir|lower|lower-expr|enrichments|wire-projection|validate|invariant-classify|walker-primitive-expander|prov-id)['\"]" src/ web/ test/`
  should return zero results. Anything that hits is a missed rewrite.
  Plus `rg "from ['\"][^'\"]*ir/migrations-builder['\"]" src/` should
  also be zero (it moved to `system/`).

## Execution sketch (when implemented)

1. Make the four phase subdirs under `src/ir/` (`types/`, `lower/`,
   `enrich/`, `validate/`) plus `util/`.
2. `git mv` each file to its new home (11 moves, one of which is the
   cross-layer move of `migrations-builder.ts` to `src/system/`).
3. Run the rewrite sweep across `src/`, `web/`, `test/`, `vscode/`,
   `packages/` — a single `sed` per old→new path pair.
4. `npm run langium:generate && npm run build && npm test`.
5. Smoke a generator end-to-end:
   `node bin/cli.js generate system examples/acme.ddd -o /tmp/loom-out --dry-run | head`.

Estimated diff: 11 file moves + ~214 import-line edits + 1 ripgrep
verification. Single PR.

## What's deliberately *not* in scope

- **`src/language/`** — Langium's module wiring expects `ddd-scope.ts`,
  `ddd-validator.ts`, `ddd-module.ts` at the package root. Restructuring
  there fights the framework. Possible follow-up: pull `type-system.ts`
  (1233 lines) and `walker-stdlib.ts` under a `semantics/` subdir, but
  that's a separate decision.
- **`src/system/`** — also a worthwhile phase reveal
  (`orchestrator/diagrams/e2e/contracts`), but each renderer in
  `src/system/` is self-contained and the directory is small enough
  (~3.2k lines, 11 files) that the current flat layout is borderline
  acceptable. Defer.
- **`src/generator/<platform>/`** — Phoenix's 19 flat files would
  benefit from the same `emit/` subgrouping `dotnet/` and `typescript/`
  already use. Defer to a per-platform proposal.

## Open questions

- **`util/prov-id.ts` — is `src/ir/util/` the right home, or should it
  graduate to `src/util/prov-id.ts`?** It's only used by IR-adjacent
  code today (provenance ids on lowered nodes), but the FNV-1a hash
  itself is generic. Keep in `ir/util/` until a non-IR caller appears.
- **Should we split `lower.ts` further (1987 lines)?** Not in this
  proposal — splitting is a refactor decision separate from "reveal
  phases", and the file already partitions internally by visitor
  method. Revisit only if the file keeps growing.
- **Index re-exports — yes or no?** We could add
  `src/ir/types/index.ts` re-exporting from `loom-ir.ts` so external
  importers write `from "../ir/types"` instead of
  `from "../ir/types/loom-ir.js"`. Marginal benefit; would mean an
  extra file per subdir. Recommendation: skip; the explicit path is
  fine.
