# T9 — Toolchain & process health

*Weak-spot #5: the expression/statement/walker axes are correctly abstracted and CI-pinned; the persistence-emit axis and the version axis are not, runtime feedback is nightly-only, and one human author + 190 design docs made doc rot a first-class failure mode (this plan is itself the remediation of that last one).*

## M-T9.1 — Langium 3.3 → 4.2 — `open` · **L** · P1 ⭐
The foundational bump: regenerate `src/language/generated/`, service-container/scope/validation-registry/LSP-provider signature changes, reflection-helper moves, langium-test helpers. Clears the remaining 8 `npm audit` findings (3 high — lodash chain) that CANNOT clear otherwise. Dedicated branch; gate on full `npm test` + `langium-generated.yml` determinism. Use the `dependency-upgrade` skill.
Sources: [dependency-upgrades](../old/proposals/dependency-upgrades.md).

## M-T9.2 — Persistence-emit seam (`PersistenceTarget`) — `open` · **XL** · P1 ⭐ (design-first)
The last un-abstracted N: entity/schema/repository/routes emission is hand-written per backend (elixir 70 files / dotnet 61 / java 51 / python 37); every storage feature re-lands N times (part-in-part: 36 files). Design the analogue of `ExprTarget`/`WalkerTarget` for the regular-shaped persistence fragments. **Start from the design brief: [`missions/M-T9.2-persistence-seam-brief.md`](missions/M-T9.2-persistence-seam-brief.md)** — divergence audit first (with the pre-registered decline criterion), then contract + slicing for sign-off, then byte-identical extraction one fragment × one backend at a time (PRs #607–#627 pattern). **T10 target growth stays frozen until this exists.**
Sources: the brief, weak-spots §5, maintenance audit.

## M-T9.3 — Per-PR runtime boot gates — `partial` · **L** · P1
Compile-only per-PR gates let runtime regressions ship green and fail nightly. Progress verified 2026-07-13: per-PR behavioral workflows now exist for **node, python, dotnet, java** (`behavioral-e2e{,-python,-dotnet,-java}.yml`, all `on: pull_request` with per-generator path filters) — a6.2 v2 is done except **Elixir**. Remaining: the Elixir behavioral leg, v3 unit-tier parity, global-test-coverage Phases 2–5 (feature-doc-coverage gate, manifest-driven wire-parity sweep; showcase-completeness is already HARD), and Elixir in the per-PR parity boot (with M-T6.3).
Sources: [a6.2-behavioral-tier-second-backend](../old/plans/a6.2-behavioral-tier-second-backend.md), [global-test-coverage-plan](../old/plans/global-test-coverage-plan.md), [runtime-conformance-harness](../old/plans/runtime-conformance-harness.md).

## M-T9.4 — Full-review remediation residue — `partial` · **M** · P2
A5 retire the deprecated `WorkflowIR` primary-create facade; A7.4 fullstack-embed seam on `PlatformSurface` (pairs with M-T6.1/M-T6.5); B23 heex-parity behavioral output test; C-mediums C1–C7, C11, C12, C15; #22 macro-expansion-under-LSP-rebuild (also in M-T5.16).
Sources: [full-review-remediation](../old/plans/full-review-remediation.md), [full-code-review-2026-07](../audits/full-code-review-2026-07.md).

## M-T9.5 — Version-axis consolidation — `partial` · **M** · P2
Stop forking: React `stacks/` → `src/platform/react/v{N}/` consolidation (mechanical, live); backend-packages B3+ decisions (render-expr sharing granularity, frontend single-versioning, CI version sharding); pack-versioning Phase 2 tail (Phoenix dep bump, .NET stack scaffold, shadcn@v4 bareword promote).
Sources: [platform-directory-layout](../old/proposals/platform-directory-layout.md), [backend-packages](../old/plans/backend-packages.md), [pack-versioning-plan](../old/plans/pack-versioning-plan.md), D-BACKEND-PKG.

## M-T9.6 — Doc & status hygiene — `recurring` · **S** · P2
This consolidation replaces three drifting status tables with one. Keep it true: mission status lines update on completion (see README rule 5); the `status-refresh` skill audits `docs/` (not this plan's history); stale code comments flagged by audits (registry.ts HEEx-gap claims, `ashPhoenix` references) get scrubbed. One-time task: sweep the flagged stale comments now.
Sources: weak-spots §5, old global-plan T1.4.

## M-T9.7 — Repo-admin one-clicks — `blocked(admin)` · **S** · P3
RST-4: add `behavioral-python` to branch-protection required checks. Anything else needing owner action collects here.

## M-T9.8 — Hollow-work audit — `recurring` · **M** · P1
Parallel agents sometimes *claim* done what isn't: dead code never wired in, gates softened/reverted to get CI green, skip-lists and allowlists that quietly grow, emitters that write `TODO` comments into compiling output, validators defined but unreachable, tests without assertions. Run an adversarial sweep for this class on a cadence (and after any large multi-agent push): (a) dead `render*/emit*/build*` exports in `src/generator/`+`src/platform/`; (b) every skip/allowlist + `HARD_GATE`-style flag audited against its justification; (c) generated-output TODO/placeholder strings vs honest fail-fast throws; (d) diagnostic codes defined but unemittable; (e) assertion-free tests; (f) parity gates that exclude the case they claim to cover (`LOOM_E2E_SKIP_*`, normalize filters). Confirmed hollow claims get a mission + a status correction here; the best generic checks graduate into permanent CI gates. First run 2026-07-13 found: the dead `renderSpaController` (→ M-T6.1), Feliz silent statement/expression drops (→ M-T6.15), the grown showcase allowlist over grammar-only kinds (→ M-T6.16), the guarded walker-core `undefined` fallthrough, and the Java `embedded` compile-skip. Three checks to graduate into CI (own slice, size S each): (1) **dead-export gate** — fail on any exported `render*/emit*/build*` in `src/generator/`+`src/platform/` with zero cross-file importers (knip/ts-prune); (2) **no-TODO-in-generated-output gate** — fail when the generated corpus contains emitter-written `TODO`/`unsupported`/placeholder sentinels; (3) **allowlist ratchet** — snapshot every allowlist/skip-list's entry count, fail CI on growth, require each entry to cite an open tracker.
