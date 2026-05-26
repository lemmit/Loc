# Proposal — Reveal the IR pipeline phases in `src/ir/`

> Status: **Proposal**. Nothing in this document is implemented yet.
> Companion to [`test-layout-and-macro-consolidation.md`](./test-layout-and-macro-consolidation.md)
> — that one made the *test tree* mirror the pipeline; this one does
> the same for the *IR source tree*.

## Context

`CLAUDE.md` lays out the compiler as a one-directional pipeline with
named phases:

```
AST → Lowering → Loom IR → Enrichment → Validation → (post-IR transforms) → Generator
                 src/ir/   src/ir/      src/ir/       src/ir/
```

Four of those phases — lowering, IR data types, enrichment, validation —
**all live at the same depth inside `src/ir/`**, next to two post-IR
transforms (walker-primitive expansion, migrations builder) and a
utility (`prov-id`). You cannot tell the phase order from `ls src/ir/`.

The current layout (sorted by size):

```
src/ir/  (~9.7k lines)
  walker-primitive-expander.ts  1055   ┐ post-IR transforms
  migrations-builder.ts          465   ┘
  lower.ts                      1987   ┐ AST → IR
  lower-expr.ts                 1439   ┘
  loom-ir.ts                    1615   ┐ IR data types
  migrations-ir.ts               113   ┘
  validate.ts                   1697   ┐ post-lower validation
  invariant-classify.ts          415   ┘
  enrichments.ts                 766   ┐ post-lower derivation
  wire-projection.ts              74   ┘
  prov-id.ts                     105   utility (FNV-1a hashing)
```

Five distinct phases interleaved at one level.

## Proposal — phase-named subdirectories

```
src/ir/
├── types/
│   ├── loom-ir.ts              (the IR ADT — 126 importers)
│   └── migrations-ir.ts        (migration step ADT — 14 importers)
│
├── lower/                       # AST → IR
│   ├── lower.ts                (structural walker; never descends into expressions)
│   └── lower-expr.ts           (expressions, statements, name resolution, member typing)
│
├── enrich/                      # one pure pass after lowering
│   ├── enrichments.ts          (wireShape, auto-findAll, react targets:)
│   └── wire-projection.ts      (helper used by enrichments + by system/wire-spec)
│
├── validate/                    # post-lower validation
│   ├── validate.ts             (cross-aggregate / multi-file checks)
│   └── invariant-classify.ts   (classify invariant expressions by category)
│
├── transform/                   # post-IR transforms (run after enrichment)
│   ├── walker-primitive-expander.ts   (page-archetype → walker-stdlib bodies)
│   └── migrations-builder.ts          (IR diff → migration step list)
│
└── util/
    └── prov-id.ts              (FNV-1a hash for provenance ids)
```

### Why this grouping

- **Phase-named, not file-type-named.** `lower/`, `enrich/`, `validate/`,
  `transform/` are the same words `CLAUDE.md` and `docs/technical.md`
  already use to describe the pipeline. A new contributor's mental model
  of "lower → enrich → validate → transform" lines up 1:1 with the file
  tree.
- **`types/` is what the rest of the compiler actually consumes.** 126
  files import from `loom-ir.ts`; only `lower/`, `enrich/`, `validate/`,
  `transform/`, and `prov-id.ts` import from each other. Putting the
  type ADT in its own subdir signals that distinction at the file-tree
  level: *the rest of the compiler consumes `ir/types/`, not the
  passes.*
- **Migration is a transform, not an IR concern of its own.** Today
  `migrations-builder.ts` sits next to lowering despite being a
  derivation that runs *after* the IR is built and validated — same
  shape as `walker-primitive-expander.ts`. Grouping them under
  `transform/` makes that explicit.
- **`enrichments.ts` and `wire-projection.ts` are a pair.** The
  enrichment pass produces `wireShape`; `wire-projection.ts` is the
  shared helper that `system/wire-spec.ts` also calls. They belong
  together — currently easy to miss.
- **`invariant-classify.ts` is part of validation.** It's used by
  `validate.ts` to bucket invariants by category. Sitting at the same
  depth as `lower.ts` hides that.

### What this is *not*

- **Not a logic change.** Every file moves verbatim. The structural
  walker rule "`lower.ts` imports from `lower-expr.ts`, never the other
  way" is preserved; the only change is that the import path becomes
  `./lower-expr.js` within the same `lower/` directory (it already is).
- **Not a refactor of any phase.** The 1987-line `lower.ts` stays at
  1987 lines; we are not splitting it further in this proposal.
- **Not a new layering rule.** The existing rule
  (`language → ir → generator`) is unchanged; this proposal only adds
  *intra-`ir/`* phase visibility.

## Import impact

Total external importers of `src/ir/*.ts` files today:

| File                          | Importers |
|-------------------------------|----------:|
| `loom-ir.ts`                  |       126 |
| `enrichments.ts`              |        24 |
| `lower.ts`                    |        22 |
| `migrations-ir.ts`            |        14 |
| `wire-projection.ts`          |         7 |
| `prov-id.ts`                  |         6 |
| `validate.ts`                 |         6 |
| `invariant-classify.ts`       |         6 |
| `migrations-builder.ts`       |         2 |
| `lower-expr.ts`               |         1 |
| `walker-primitive-expander.ts`|         0 |
| **Total**                     |   **214** |

214 import sites need rewriting. **All mechanical** — a single sweep per
file:

```
ir/loom-ir            → ir/types/loom-ir
ir/migrations-ir      → ir/types/migrations-ir
ir/lower              → ir/lower/lower
ir/lower-expr         → ir/lower/lower-expr
ir/enrichments        → ir/enrich/enrichments
ir/wire-projection    → ir/enrich/wire-projection
ir/validate           → ir/validate/validate
ir/invariant-classify → ir/validate/invariant-classify
ir/walker-primitive-expander → ir/transform/walker-primitive-expander
ir/migrations-builder        → ir/transform/migrations-builder
ir/prov-id                   → ir/util/prov-id
```

**Internal IR imports** also rewrite, but the new paths shorten where
files now share a subdir (`./lower-expr.js` instead of
`./lower-expr.js` — no change; `../enrich/wire-projection.js` from
`validate/` — one extra `..`).

`tsconfig.json` (`"include": ["src/**/*.ts"]`) and the langium config
need no edit. The generated parser in `src/language/generated/` does
not import from `src/ir/` and is unaffected.

## Why this is safe

- **`git mv` preserves history.** Every file blames cleanly through
  the rename.
- **Diff is mechanical and reviewable.** Two kinds of change only:
  (a) `git mv` per file, (b) one import-path rewrite per importer. A
  reviewer can spot-check by sampling — there are no judgement calls.
- **No public API change.** Nothing in `bin/`, `package.json`, the CLI,
  the VS Code extension, or the playground depends on the *intra-IR*
  module layout — they all import either the `ir/loom-ir` ADT or
  high-level CLI / system entry points.
- **The default `npm test` suite is the regression gate.** If imports
  resolve and `tsc` builds, the IR is observably unchanged.
- **Verifies one easy invariant after the move.**
  `rg "from ['\"][^'\"]*ir/(loom-ir|migrations-ir|lower|enrichments|validate|invariant-classify|walker-primitive-expander|migrations-builder|wire-projection|prov-id)['\"]" src/ web/ test/`
  should return zero results. Anything that hits is a missed rewrite.

## Execution sketch (when implemented)

1. Make the five new subdirs under `src/ir/`.
2. `git mv` each file to its new home (11 moves).
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
