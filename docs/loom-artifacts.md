# The `.loom/` artifact directory

Every `ddd generate system` run emits, alongside the per-deployable
project trees, a `.loom/` directory at the output root containing
**derived artefacts** — JSON / Markdown / Mermaid / C4 files the
generator produces for tooling and review, not for runtime
consumption.

```
<outdir>/
├── docker-compose.yml
├── db-init/
├── <deployable-1>/
├── <deployable-2>/
├── ...
└── .loom/
    ├── wire-spec.json
    ├── messages.en.json
    ├── domain.mmd
    ├── workflows.mmd
    ├── er.mmd
    ├── sequence.mmd
    ├── deployment.mmd
    ├── architecture.c4
    ├── datasources.md
    ├── traceability.md
    ├── traceability-matrix.md
    ├── traceability.mmd
    ├── traceability.json
    ├── coverage.md
    ├── gaps.md
    ├── verification.json        # written by `ddd verify`
    ├── verification.md          # written by `ddd verify`
    ├── sourcemap.json           # opt-in, only under `generate system --sourcemap`
    └── snapshots/
        ├── <Subdomain>.snapshot.json                  # migration baselines
        └── <ts>-<guid>.loomsnap.json               # provenance rule captures
```

None of the files in `.loom/` ship to runtime; they are review and
tooling output.  Check them into the project alongside the generated
code if you want pull-request-time diff visibility on wire contracts,
traceability coverage, or migration baselines.

## Wire contract

| File | Producer | What it is |
|---|---|---|
| `wire-spec.json` | `src/system/wire-spec.ts` (phase ⑨) | JSON-Schema-shaped derivation from every aggregate / part / value object's `wireShape`.  Language-agnostic; the canonical source of truth for what the JSON over the wire looks like.  Diffable — wire-contract drift between regens shows up as a clean JSON diff. |

## i18n catalog

| File | Producer | What it is |
|---|---|---|
| `messages.en.json` | `src/system/i18n-catalog.ts` (phase ⑨) | Source-language (English) message catalog — every user-visible string extracted from the system's UIs, as a flat, key-sorted `{ key: message }` object.  Keys are content-hashed (`page.<Page>.<role>.<hash>` / `component.<Comp>.<role>.<hash>` / `menu.<role>.<hash>`, D-I18N-KEY) so the catalog is reorder-invariant and a rephrase re-keys cleanly (delete-old + add-new).  The diff surface a future `ddd i18n sync` merges each locale against (M-T1.11, [`docs/old/proposals/i18n.md`](old/proposals/i18n.md)). **This slice extracts plain string literals only** — interpolated strings (`"Order ${o.id}"`) await the template→ICU lowering slice. Extraction: `src/generator/_walker/i18n-extract.ts`. |

## Storage routing

| File | Producer | What it is |
|---|---|---|
| `datasources.md` | `src/system/datasources.ts` → `renderDataSourcesMd` | Per-system Markdown view of how `resource` declarations route domain contexts to physical storage.  Two sections: per-deployable routing (context → kind → storage with effective schema / table-prefix), and per-storage usage roll-up.  Catches accidental "primary" sharing and unused bindings at PR-review time. |

## Diagrams

| File | Producer | What it is |
|---|---|---|
| `domain.mmd` | `src/system/mermaid.ts` → `renderDomainDiagram` | Mermaid class diagram of every aggregate, value object, enum, and event in the system, with containments and `X id` references drawn as relationships. |
| `er.mmd` | `src/system/mermaid.ts` → `renderErDiagram` | Mermaid entity-relationship diagram of every persisted aggregate + part — schema-shaped (PK / FK / columns), not class-shaped. |
| `workflows.mmd` | `src/system/mermaid.ts` → `renderWorkflowDiagram` | One Mermaid flowchart per workflow, showing the create / load / mutate / emit steps. |
| `sequence.mmd` | `src/system/mermaid.ts` → `renderSequenceDiagram` | Mermaid sequence diagram of an operation lifecycle (client → route → repository → DB → events). |
| `deployment.mmd` | `src/system/mermaid.ts` → `renderDeploymentDiagram` | Mermaid deployment diagram of the system's deployables, their target backends, and their shared storage. |
| `architecture.c4` | `src/system/likec4.ts` → `renderC4Model` | [LikeC4](https://likec4.dev/) model of the system at C4 levels 1–3 (context, container, component).  Renderable in the LikeC4 viewer / VS Code extension. |

## Traceability

| File | Producer | What it is |
|---|---|---|
| `traceability.md` | `src/system/traceability.ts` → `renderTraceabilityDoc` | Per-requirement Markdown index: each `requirement` block with its linked `solution`s, `testCase`s, and the runnable `test` / `test e2e` that verifies each test case. |
| `traceability-matrix.md` | `src/system/traceability.ts` → `renderMatrix` | Two-axis matrix view (requirement × test case). |
| `traceability.mmd` | `src/system/traceability.ts` → `renderTraceabilityDiagram` | Mermaid graph of the requirement → solution → testCase → test graph. |
| `traceability.json` | `src/system/traceability.ts` → `renderTraceabilityJson` | Machine-readable form of the same graph (for CI gating, custom reports). |
| `coverage.md` | `src/system/traceability.ts` → `renderCoverageReport` | Per-solution and per-requirement coverage roll-up. |
| `gaps.md` | `src/system/traceability.ts` → `renderGapsReport` | Inverse of coverage — requirements with no solution, solutions with no test case, test cases with no test. |
| `verification.json` | `ddd verify` (`src/cli/main.ts`) | Join of the requirements graph with a JSON of test results — every requirement gets a `VERIFIED / FAILING / UNVERIFIED / UNTESTED` verdict. |
| `verification.md` | `ddd verify` | Human-readable companion to `verification.json`. |

See [`traceability.md`](traceability.md) for the surface that
populates these.

## Snapshots

`snapshots/` carries two kinds of file, both immutable:

| Pattern | Producer | What it is |
|---|---|---|
| `<Subdomain>.snapshot.json` | `src/system/snapshot.ts` + `src/system/migrations-builder.ts` (phase ⑨) | Migration baseline.  One file per subdomain that owns a database schema; written on every `generate system` run.  Diffed against the previous file on the next regen by `buildMigrations` to derive the next migration step; per-backend emitters (`src/generator/typescript/emit/migrations.ts`, `dotnet/emit/migrations.ts`, `python/emit/migrations.ts`, `java/emit/migrations.ts`, and `elixir/migrations-emit.ts`) translate the resulting `MigrationsIR` to platform-specific files — see [`migrations.md`](migrations.md). |
| `<ts>-<guid>.loomsnap.json` | `ddd snapshot` (`src/system/loomsnap.ts`) | Provenance rule snapshot.  One immutable timestamped+GUID file per system; captures the rule snapshots for every `provenanced` field.  The latest such file is the one the generated runtime loads at startup.  See [`provenance.md`](provenance.md). |

Migration snapshots are derived from the IR and written on every
regen.  Provenance snapshots are only written by the explicit
`ddd snapshot` sub-command — never by `generate`.

## Source map (opt-in)

`sourcemap.json` is the one artifact **not** written by default — it lands only
when `generate system` is passed `--sourcemap`.  Emitted by `src/system/sourcemap.ts`
from an `Origin` spine that all five backends thread through their emitters, it maps
each generated line back to the `.ddd` construct — and, for operation bodies, the
`.ddd` statement — it came from, at both construct and statement granularity.

Its consumer is `ddd trace <logfile>`: given a runtime stack-trace from a generated
backend, it rewrites each frame to point at the originating `.ddd` source line, so a
failure in the generated code reads against the model the author actually wrote.  See
[`tools.md`](tools.md) for the CLI.

## What `.loom/` is NOT

- **Not deployed.**  Production projects don't read anything from
  `.loom/` at runtime; the directory is build-time-only.  The one
  exception is `<ts>-<guid>.loomsnap.json` files, which the Hono
  provenance SDK loads to render trace records — but they are
  loaded from a path inside the deployable's own folder during
  capture, not from `.loom/` at runtime.
- **Not regenerated incrementally.**  Every file in `.loom/` is
  fully rewritten on each `generate` run.  Don't hand-edit; pin via
  `.loomignore` if you absolutely must keep a custom version.
- **Not part of the wire contract.**  The wire contract is what
  `wire-spec.json` *describes*, not the file itself.  Backends emit
  the actual schemas (Zod, EF DTOs, Ecto schemas) directly into
  their own project trees.

## Cross-references

- [`generators.md` § Migrations](generators.md) — what
  `<Subdomain>.snapshot.json` diffs become at backend emission time
  (per-platform output table and `MigrationsIR` plumbing).
- [`provenance.md`](provenance.md) — the `ddd snapshot` capture
  step and the runtime trace SDK.
- [`traceability.md`](traceability.md) — the requirement / solution
  / testCase surface that produces the traceability files.
- [`technical.md`](technical.md) — phases ⑨ (composes
  `<outdir>/`) and ⑩ (writes everything via the `.loomignore`
  filter).
