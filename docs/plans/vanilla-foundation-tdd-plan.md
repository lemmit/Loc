# Vanilla Phoenix foundation — TDD slice plan (P2)

> Status: **landed / superseded (de-Ash effort, 2026).** Steps 1–4 of the de-Ash
> effort have landed: the Ash foundation is **removed**. `foundation: vanilla`
> (plain Ecto/Phoenix, no Ash) is now the **default and only valid** elixir
> foundation; `foundation: ash` is a validation error (the `foundation:` knob
> stays). This TDD plan delivered that vanilla emit subtree; the cross-backend
> wire-parity tiers below used `foundation: ash` as the parity oracle **while both
> foundations co-existed** — once Ash was deleted the parity target became the
> other backends (Hono/.NET) directly. Retained as the implementation record.
>
> Plan-of-record for `foundation: vanilla` — P2 of
> [`../proposals/vanilla-phoenix-foundation.md`](../proposals/vanilla-phoenix-foundation.md),
> per decisions **D-VANILLA-PHOENIX-FOUNDATION** / **D-PHOENIX-FOUNDATION-STRATEGY**.
> P0 (ES-on-ash diagnostic) and P1 (foundation-axis plumbing) shipped (#1032). This
> plan covered the **state-based** emit subtree first; ES-on-vanilla (P4) followed
> on the same scaffolding.
>
> **Naming note:** the `platform: phoenix` → `platform: elixir` rename
> (#1043) landed *after* this plan was first written. Workflow filenames
> below reflect the post-rename `elixir-*` convention; in-tree generator
> identifiers (`generateElixirProject`, `src/generator/elixir/`) likewise.

## The constraint that shapes everything

**There is no local Elixir/`mix` toolchain.** `mix compile --warnings-as-errors`
is reachable only in CI (`elixir-vanilla-build.yml`). So the local red→green
loop *cannot* be the Elixir compiler. It is, instead:

- **Per-emitter structure tests** (vitest, string assertions on emitted `.ex`) —
  the same shape as today's `test/generator/phoenix/*-emit.test.ts` (test dir
  not renamed; only the `src/generator/` dir flipped). Fast, local.
- **Cross-backend wire parity** — the decisive contract gate. Two tiers:
  - *local, fast*: an `elixir-vanilla-wire-conformance` test mirroring
    `test/generator/{hono,dotnet}/*-wire-conformance.test.ts` + the
    `test/_helpers/openapi-normalize.ts` normaliser — asserts the vanilla
    OpenAPI/wire-spec equals the ash one for the same `.ddd`, in-process, no boot.
  - *CI, slow*: strict `LOOM_E2E_STRICT_PARITY=1` (`test/e2e/e2e.test.ts`) boots
    the generated app and diffs the live spec.

**`mix compile` is the acceptance gate, out of the inner loop.** Implication:
the structure + parity tests must be tight enough that CI mostly rubber-stamps.
Every slice ends with a push so CI compiles it; we do **not** batch many slices
before the first CI compile.

## Test ladder (what gates what)

| Tier | Tool | Loop | Drives |
|---|---|---|---|
| Structure | vitest `*-emit` string asserts | local, seconds | per-file Elixir shape |
| Wire parity (fast) | vitest conformance + `openapi-normalize` | local, seconds | the cross-backend contract |
| Compile | `elixir-vanilla-build.yml` (`mix compile --warnings-as-errors`) | CI, minutes | Elixir correctness (acceptance) |
| Live parity (strict) | `LOOM_E2E_STRICT_PARITY=1` e2e | CI, minutes | spec == ash at runtime |
| Obs | `elixir-vanilla-obs-e2e.yml` (vanilla variant) | CI | telemetry envelope |

## Vertical slices (each: write tests red → emit to green → push → CI compiles)

The cut is **vertical** (one aggregate end-to-end), not horizontal (all schemas,
then all changesets…), so the parity gate closes on a minimal case at slice 1 and
every slice is independently green + CI-compilable.

**Slice 0 — harness + orchestrator branch.**
- Tests first: a `foundation: vanilla` deployable lowers + lifts the
  `loom.foundation-vanilla-phoenix-not-yet-implemented` gate
  (`src/language/validators/deployable.ts`); `generateElixirProject`
  dispatches to a `vanilla/` orchestrator (today it early-returns `{}` for
  vanilla). Add the smallest fixture (`vanilla-min.ddd`: one CRUD aggregate).
- Emit: the orchestrator branch + an empty `vanilla/index.ts` returning the
  shell files only. Green = gate lifted, shell emits, nothing else asserted yet.

**Slice 1 — one CRUD aggregate, read path, parity-closed.**
- Tests first:
  - structure: `vanilla/schema-emit` → `use Ecto.Schema` + columns;
    `vanilla/repository-emit` → `find_by_id/1` + `list/1` returning `{:ok,_}|{:error,_}`;
    `vanilla/context-emit` → plain context fn per read; `vanilla/api-emit` →
    `GET /<aggs>` + `GET /<aggs>/{id}` controller with `with`-block dispatch;
    migrations: reuse `migrations-emit.ts` (foundation-agnostic) → `<aggs>` table.
  - **parity**: `vanilla` wire-spec for `vanilla-min.ddd` == `ash` wire-spec
    (operationIds, response schemas, field set, required flags, path-param types,
    ProblemDetails envelope) via the normaliser. **This is the load-bearing test.**
- Emit those four `vanilla/*` emitters minimally; green both tiers; push → CI
  `mix compile` confirms the Elixir.

**Slice 2 — create/update/destroy + changesets + policies.**
- Tests first: `vanilla/changeset-emit` (`cast/3` + per-field `validate_*` +
  per-action `change_<op>/2`); create/update/destroy controller actions returning
  typed results; `vanilla/policy-emit` (`can_<op>?/2` guard fns) for `requires`;
  parity extends to the create/op/destroy operationIds + request DTOs.
- Emit; green; push.

**Slice 3 — enums / value objects / relationships.**
- Tests first: VO → embedded schema or flattened columns (match ash's wire);
  enum column + the camelCase `Jason.Encoder` shape; `X id` relationship →
  explicit FK column + eager-load query in the repository. Parity must hold for
  every wireShape field.
- Emit; green; push.

**Slice 4 — exception-less alignment (the payoff).**
- Tests first: the controller emits per-variant `with`-block dispatch over typed
  `or`-union returns (no `Plug.ErrorHandler` `Ash.Error.*` rescue tower);
  `vanilla/problem-details-emit` builds the RFC-7807 envelope per variant,
  byte-identical to the ash tower's output (parity dimension 9).
- Emit; green; push.

**Slice 5 — workflows + views on vanilla (closes the loop that started this).**
- Tests first: workflow code-interface + dispatcher already foundation-agnostic;
  the saga state is *already* plain Ecto — so on vanilla the **deferred Phoenix
  workflow-instance views** become a plain Ecto `from … where` read (no Ash
  special-casing). Assert the workflow-view route + the instance endpoints emit
  on vanilla with parity to Hono/.NET.
- Emit; green; push. (This is the slice that retires the
  `workflow-instance-views.md` Phoenix deferral.)

**Slice 6 — CI wiring + an example.**
- Add `elixir-vanilla-build.yml` (+ obs-e2e vanilla variant); add one
  `examples/*-vanilla.ddd` so the example matrix exercises it; strict-parity e2e
  entry for a vanilla deployable.

**(Later) P4 — ES on vanilla.** `<Agg>.Events` Ecto schema + `<Agg>.Fold`
(`from_events/2` + `apply_event/2`) + event-store repository; reuses the shared
`<agg>_events` `MigrationsIR` table. A new red→green slice on this scaffolding;
un-gates `validateEventSourcedStorage` for `foundation: vanilla` (D-VANILLA-ES-HOME).

## Reuse (do not re-emit)

Foundation-agnostic, shared with the ash path: `heex-walker.ts` + `heex-target.ts`
(the LiveView body walker), `migrations-emit.ts` (consumes `MigrationsIR`),
`render-expr.ts` / `render-stmt.ts` (Elixir expression/statement rendering — but
see risk below), OpenAPI emit, `JasonCamelCase`, telemetry, seeds, theme,
sidebar, shell. The `vanilla/` subtree only re-implements the **resource/action**
layer (schema / changeset / repository / context / policy / controller /
problem-details) + an `ecto-postgres-persistence` adapter advertising
`["state","eventLog"]`.

## Risks / gotchas (front-loaded)

1. **`render-expr.ts` is Ash-flavoured at the edges** — enum values render as
   atoms (`:pending`), filters target `Ash.Query.filter`. Vanilla Ecto wants
   string columns + Ecto `where`. Decide early: a `renderCtx` flag or a thin
   vanilla expr target. This was the exact blocker on the deferred Phoenix
   workflow view — solve it once here.
2. **ProblemDetails byte-parity** — the ash rescue tower's `Ash.Error.Invalid`
   → 422 `errors[]` formatting must be reproduced exactly by the vanilla
   per-variant builder. Pin it with a parity test before emitting.
3. **`timestamps()` / inserted_at-updated_at** must not leak into the wire shape
   (they're not in `wireShape`) — parity will catch it, but expect it.
4. **CI-only compile** means a slice can be green locally yet fail `mix`. Keep
   slices small; push each; read `elixir-vanilla-build.yml` logs as the truth.

## Parallelization

The properties that make this plan safe — one global parity oracle, CI-only
compile, deliberately vertical slices — also bound how much parallelizes. The
split:

- **Phase A — serial, single owner (no fan-out).** Slice 0 + Slice 1: the
  orchestrator branch, the parity harness, the vanilla `render-expr` target, and
  one CRUD aggregate end-to-end with parity green. This is the spine every later
  slice builds on; it cannot be split.
- **Phase B — worktree fan-out (2–3 agents), *after* the spine.** Once the
  harness exists, the genuinely independent leaf string-builders — each an "IR
  slice → Elixir" unit with its own structure tests — fan out in isolated git
  worktrees (`isolation: "worktree"`): e.g. `changeset-emit`, `policy-emit`,
  `problem-details-emit`. The owner integrates them **one at a time** and runs
  the single parity gate after each. Keep it to 2–3 leaves: past that the
  merge + parity-attribution + CI-serialization tax exceeds the speedup on a
  single-contract, CI-only-compile generator.
- **Cross-cutting — read-only research fan-out (immediate, any time).** Pin the
  byte-exact ash behaviors the parity tests must encode, in parallel: the
  `Ash.Error.*` → ProblemDetails envelope (422 `errors[]`, 403/404/400 bodies +
  headers), the `TypeIR` → Ecto schema/column + migration mapping, and the
  Ash-flavoured edges of `render-expr.ts` a vanilla Ecto expr target must diverge
  from. These have no integration risk and directly feed the test-first specs.
- **Always serial (single owner):** integration, parity-closing, and every CI
  push. Parallel pushes to one branch interleave CI runs you can't attribute;
  parallel branches only validate the integrated whole.

## Definition of done (state-based, this plan)

`foundation: vanilla` on a CRUD `.ddd`: lifts the gate, emits the full `vanilla/`
tree, `mix compile --warnings-as-errors` green in CI, strict wire parity with
`foundation: ash` (all 9 dimensions), obs-e2e green, one example in the matrix.
ES-on-vanilla and the default-flip (D-VANILLA-DEFAULT) are explicitly out of scope
here.
