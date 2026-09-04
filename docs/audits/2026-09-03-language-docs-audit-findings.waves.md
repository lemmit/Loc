# Draining the 2026-09-03 language-docs findings — the wave plan

*Companion to [`2026-09-03-language-docs-audit-findings.md`](2026-09-03-language-docs-audit-findings.md).
That register says what is broken; this says in what order to fix it, how the work splits
across parallel agents without collisions, and what each packet must prove before it merges.
Machine-readable twin: [`2026-09-03-language-docs-audit-findings.waves.json`](2026-09-03-language-docs-audit-findings.waves.json).*

**Every packet below carries its minted mission id** — the track files in
[`docs/new-plan/`](../new-plan/README.md) own status from here (M-T5.26–M-T5.29, M-T1.28–M-T1.31,
M-T6.53–M-T6.58, M-T9.44–M-T9.47); this file is the snapshot of the plan and loses to them on
any disagreement. Dispositioned in [`coverage.md`](../new-plan/coverage.md).

## The sequencing argument

Seventeen of the 47 findings are P0/P1 — valid `.ddd` that emits a project which does not
compile, or silently omits a thing the model declares. Those come first, because every hour
they stay open is an hour someone can hit them with no diagnostic to explain what happened.

But the *order within* the P0/P1 set is not by severity. It is by **whether the fix teaches the
compiler something reusable**:

- **Wave 4 (catalog gate) is the highest-leverage packet in the plan** and could reasonably run
  first. Extending `diagnostic-catalog.test.ts` to reach `src/ir/validate/checks/**` retires
  eleven findings as a *class* and prevents the twelfth. It is scheduled after the crashes only
  because a broken build is louder than a lying message.
- **Wave 2 (walker predicates) fixes a shape, not four bugs.** F10/F11/F12/F17 are all the same
  defect wearing different clothes: a dispatch predicate that returns "no" on an unrecognised
  node and lets emission continue as if nothing was declared. Fixing them one at a time and
  skipping the shared signal would guarantee a fifth.
- **Wave 5 (divergences) is last and could be dropped** without the toolchain being wrong —
  these are targets disagreeing, and the docs now describe the disagreement honestly. They are
  debt, not breakage.

**Waves run sequentially; packets inside a wave run in parallel.** Peak concurrency is four
agents, which is well inside the shared runner pool. Eighteen packets total.

## The collision protocol

`main` moves fast and parallel agents collide — CLAUDE.md's claiming rules are not optional
here. Every packet, without exception:

1. **Re-verifies the finding on fresh `main` first.** The register is a snapshot; several of
   these could be fixed by the time a packet starts. If the gap is gone, the packet closes with
   a note and no PR — that is a success, not a wasted slot.
2. **Opens a draft PR naming its packet id before writing code**, with a body listing the
   findings it claims and the file trees it touches.
3. **Owns a disjoint file tree.** The `fileTrees` field of each packet in the JSON is the
   contract. Two packets in the same wave never name the same file.
4. **Rebases before pushing.**

**The one shared hot file is `src/diagnostics/messages.ts`** — every packet that mints or
edits a `loom.*` code touches it. Appends to the catalog object usually merge cleanly, but
packets W2.3, W3.1, W3.2, W4.1 and W4.2 all write there. They are spread across three waves
deliberately; within a wave, only one packet is ever allowed to mint a code.

## The proof bar

Per CLAUDE.md, **a gate nobody proved is a gate nobody has.** Every packet that adds a
validator or a test must show it *fails* when the fix is reverted, and say so in the PR body.
Revert the mutation with a file copy, never `git checkout -- <path>` — checkout restores HEAD
and silently discards every other uncommitted edit in that file, so a proof reverted that way
can fail for a reason unrelated to the mutation and read as a pass (`experience_gathered.md`
§84). Read *which* assertion failed, not just that one did.

Packets that change an emitter must additionally compile the generated project for the
backend they touch — a `tsc --noEmit` / `mix compile` / `gradle testClasses` pass is the whole
point when the finding is "the output does not compile". The `loom-test-suites` skill carries
the Docker recipes; the `loom-ci-gates` skill maps a change to the workflow that gates it and
to the `run-*` label that forces a post-merge-only gate onto the PR. **Run the gate locally —
never push to see a check's verdict.**

---

## Wave 1 — the generated project must compile (4 packets)

Four independent miscompiles. Nothing here is a design question; each has one right answer.

| Packet | Findings | Trees | Proof |
|---|---|---|---|
| **W1.1 `optional-receiver-lowering`** → [M-T5.26](../new-plan/T5-language-core.md) | F2 | `src/ir/lower/lower-expr.ts`, `src/generator/dotnet/render-expr.ts`, `test/ir/**` | The form the validator recommends (`x != null ? x.trim() : …`) compiles on all five backends. Mutation-prove the new lowering arm. Also settle the .NET `ToUpper` vs `ToUpperInvariant` inconsistency in the same PR. |
| **W1.2 `react-flutter-page-shell`** → [M-T1.28](../new-plan/T1-ui-frontend.md) | F3, F9 | `src/generator/react/**`, `src/generator/flutter/**` | `toast(...)` resolves to something real (Svelte's `src/lib/toast.svelte.ts` is the reference implementation to mirror); a `derived` reading a store field emits the subscription. Generated web project type-checks. |
| **W1.3 `python-client-elixir-fn`** → [M-T6.53](../new-plan/T6-backend-parity.md) | F7, F8 | `src/generator/python/api-client.ts`, `src/generator/elixir/vanilla/function-emit.ts` | `File?` through an api resource imports `FileRef` and renders one `| None`; the Elixir block function's head keeps the parameter its body reads. Both generated projects compile. |
| **W1.4 `lowerer-and-system-crashes`** → [M-T5.27](../new-plan/T5-language-core.md) | F5, F6 | `src/ir/lower/lower.ts` (`lowerSeed`), `src/system/expect-stmt.ts`, `src/system/ui-e2e-render.ts` | Neither input throws. For F5 the fix is ordering — `loom.seed-abstract-aggregate` must fire *before* the lowerer dereferences `fields`. For F6, either the matcher survives the ui-e2e path or a `loom.*` gate rejects the shape; an internal throw is not an option. |

> **W1.1 and W1.4 both live under `src/ir/lower/`** but own different files
> (`lower-expr.ts` vs `lower.ts`). Do not let either widen.

## Wave 2 — the walker stops failing open (3 packets)

The wave with a shared thesis. Read the "Cross-cutting reading" section of the register before
starting any packet here.

| Packet | Findings | Trees | Notes |
|---|---|---|---|
| **W2.1 `walkable-match-body`** → [M-T1.29](../new-plan/T1-ui-frontend.md) | F10 | `src/generator/_walker/walker-core.ts`, per-frontend page emitters | The walker already has full `match` arms and **Vue already renders this page** — so Vue is the control, and the fix is the predicate, not new rendering. Mutation-prove on React *and* Svelte; assert Vue is unchanged. |
| **W2.2 `element-position-walk`** → [M-T1.30](../new-plan/T1-ui-frontend.md) | F12 | `src/generator/_walker/primitives/text.ts` | Give element-position `walk` the method-call arm it lacks, so a `KeyValueRow` value behaves like a `Text` value. Check the other primitives routing through the same path. |
| **W2.3 `walker-honest-gates`** → [M-T1.31](../new-plan/T1-ui-frontend.md) | F11, F17 | `src/ir/validate/checks/ui-checks.ts`, `src/diagnostics/messages.ts` | The two that should stay refusals rather than become features: `DestroyForm { of: <record> }` and Flutter's missing extern hatch. Mints codes — **the only Wave-2 packet allowed to touch `messages.ts`.** |

**The wave's real deliverable** is a shared invariant: *the walker must never decline to render
a declared element without a diagnostic.* Whichever packet finishes first should propose where
that assertion lives (a `_walker` conformance test enumerating the dispatch predicates is the
obvious home); the other two adopt it. That is what stops a fifth instance.

## Wave 3 — ungated shapes get honest gates (2 packets)

| Packet | Findings | Trees | Design fork |
|---|---|---|---|
| **W3.1 `statement-scope-gates`** → [M-T5.28](../new-plan/T5-language-core.md) | F1, F4 | `src/ir/validate/checks/**`, `src/diagnostics/messages.ts`, `test/**` | **Real fork, resolve before coding.** `variant-match` off a page and `for`/`if let` off a workflow could each be *gated* or *lowered*. Default is gate: both are frontend/workflow-only by design per the source comments, and a gate is S where lowering is L. If the design pass concludes lowering is right, that is a `language-feature-developer` mission, not this packet — split it out and say so. |
| **W3.2 `single-system-gate`** → [M-T5.29](../new-plan/T5-language-core.md) | F36 | `src/language/validators/composition.ts` | Small and unambiguous: a direct "exactly one `system`" check, not the current fold-triggered one. |

## Wave 4 — the catalog gate reaches the IR leaves (2 packets, stacked)

**The leverage packet.** W4.2 stacks on W4.1's branch rather than waiting for merge.

| Packet | Findings | Trees | Notes |
|---|---|---|---|
| **W4.1 `catalog-gate-extension`** → [M-T9.44](../new-plan/T9-toolchain-health.md) | F25, F26, F30 | `test/system/diagnostic-catalog.test.ts`, `src/ir/validate/checks/**`, `src/language/validators/statements.ts`, `src/diagnostics/messages.ts` | Extend the gate to walk `src/ir/validate/checks/**` and the AST validators, then fix everything it newly catches: mint `loom.function-block-impure`, give the `when`-gate check a code at all, and stop `loom.projection-event-unkeyed` interpolating `undefined`. **Mutation-proof is the point** — the extended gate must fail on today's `main` before the fixes land. |
| **W4.2 `stale-message-text`** → [M-T9.45](../new-plan/T9-toolchain-health.md) | F27, F28, F29, F31, F32, F33, F34, F35 | `src/diagnostics/messages.ts`, `src/util/intrinsics.ts`, `src/ir/lower/lower-expr.ts`, `src/language/ddd.langium`, `src/ir/types/loom-ir.ts`, `src/generator/_obs/log-events.ts` | Messages that contradict their own gate, comments naming codes that do not exist, one dead gate (F29 — decide: delete or add the missing family), one orphan catalog entry. Mostly text, but each edit needs the grep that proves the claim it replaces. |

## Wave 5 — cross-backend divergence (4 packets)

Debt, not breakage — the docs now describe each divergence honestly, so this wave is
schedulable rather than urgent. Naturally disjoint by target.

| Packet | Findings | Trees |
|---|---|---|
| **W5.1 `java-filter-and-invariant`** → [M-T6.54](../new-plan/T6-backend-parity.md) | F18, F19 | `src/generator/java/emit/repository.ts`, `src/generator/java/emit/validator.ts`, `src/generator/java/capability-filter.ts` |
| **W5.2 `elixir-enforcement`** → [M-T6.55](../new-plan/T6-backend-parity.md) | F14, F15, F24 | `src/generator/elixir/vanilla/changeset*.ts` |
| **W5.3 `elixir-wire-and-heex`** → [M-T6.56](../new-plan/T6-backend-parity.md) | F16, F20, F22, F23 | `src/generator/elixir/vanilla/wire-serialize.ts`, `src/generator/elixir/heex-primitives.ts`, the Ecto migration emitter |
| **W5.4 `envelope-parity`** → [M-T6.57](../new-plan/T6-backend-parity.md) | F21 | *scoping only* |

**W5.1 first in this wave** — `ignoring` that does not ignore is the one finding here with a
behavioural consequence rather than a shape difference. Its fail-direction is safe (Java
over-restricts), which is why it is not Wave 1.

**W5.4 is a scoping packet, not a fix.** "`envelope` is five-way inconsistent" is a parity
question, not a bug with a known answer: hand it to `parity-auditor` to produce the
who-emits-what matrix and a decision on what `envelope` *should* mean, then file the fix as a
mission. Do not let an agent guess at the intended semantics.

**F20 (Elixir maps a value object to `:map`) may be a decision, not a defect.** The register
records it as a divergence from the "one DDL for everyone" invariant; W5.3 must establish
which it is before changing the emitter — a deliberate Ecto choice belongs in the docs, and
chapter 3 already carries it as an honest gap.

## Wave 6 — `handle` and named `create` (1 packet, L)

**Packet W6.1 `workflow-handle-entrypoints` → [M-T6.58](../new-plan/T6-backend-parity.md).**

**F13**, on its own, because it is the only finding that is a *missing feature* rather than a
defect. The IR carries `WorkflowIR.handlers`, a test pins the lowering, and a diagnostic
message promises routing works — but no backend emits an entry point.

Two honest outcomes: emit the entry points on all five backends, or gate the declaration and
correct `loom.duplicate-handler`'s message. This is a `language-feature-developer` mission with
a design pass and user sign-off, not a fix packet. Route it there rather than into a wave.

## Wave 7 — doc drift (2 packets, parallel with anything)

No dependency on any other wave; run whenever there is a spare slot.

| Packet | Findings | Notes |
|---|---|---|
| **W7.1 `per-feature-doc-drift`** → [M-T9.46](../new-plan/T9-toolchain-health.md) | F37–F46 | Strictly docs-only, per `status-refresh`: `capabilities.md`, `inheritance.md`, `auth.md`, `tenancy.md`, `actions.md`, `observability.md`, `resources.md`, `macro-api.md`, `scaffold-macros.md`, and CLAUDE.md's primitive count. Every claim re-derived from code, as in the audit that found them. |
| **W7.2 `docs-heading-slugger`** → [M-T9.47](../new-plan/T9-toolchain-health.md) | F47 | Code, not docs: `docs/build.mjs` renders headings without `id`s, so **every** in-page `](#…)` link in every chapter is dead on the published site. One `marked` slugger extension. The audit just added a lot of cross-links, which makes this worth more than it was last week. |

---

## What "done" looks like

The drain is complete when: no valid `.ddd` in the corpus crashes `generate system`; every
silent drop in the register either renders or raises a `loom.*` code; the catalog gate reaches
every validator leaf and `main` is green under it; and the register's P2 rows are either fixed
or recorded as decisions in the reference chapters that already describe them.

Track status in `docs/new-plan/` per the repo's rule that it is the only authoritative status
table — not here. This file is a snapshot of the plan as drawn on 2026-09-03; if it disagrees
with a track file later, the track file wins.
