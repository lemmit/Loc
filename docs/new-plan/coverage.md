# Coverage — disposition of every archived proposal & plan

*Guarantee: every doc that lived in `docs/proposals/` and `docs/plans/` (now under [`../old/`](../old/)) is listed here. `shipped` / `done` / `superseded` / `historical` = no open work (the doc remains the design record). Anything with open work names the mission(s) that carry it. Classified 2026-07-13; a mission's first step is always re-verification against fresh `main`.*

## Proposals (`docs/old/proposals/`)

| Doc | Status | Open work → missions |
|---|---|---|
| accessibility.md | partial | M-T1.12 |
| agent-tools-and-mcp.md | partial | M-T8.3, M-T8.4 |
| aggregate-inheritance.md | partial (I1–I3 shipped) | M-T5.7; shape-change migration → M-T2.4 |
| ai-authoring-loop.md | partial | M-T8.3 |
| ai-diagnostics-contract.md | partial | M-T8.5 |
| ai-generation-platform.md | strategy | wedge demo → M-T8.3 (D-AI-EMPHASIS pinned) |
| angular-frontend.md | shipped | tails → M-T1.14 |
| api-openapi-tag-grouping.md | proposed | M-T6.13 |
| async-actions-and-effects.md | partial | M-T1.7 |
| audit-and-logging.md | partial | M-T3.9 |
| authorization.md | partial (→P3.2 shipped) | M-T3.2, M-T3.3 |
| blazor-server-frontend.md | proposed | M-T10.4 (R1 → M-T9.2 family) |
| bounded-context-model.md | shipped (core) | deferred futures noted in-doc; no live mission |
| capability-emission-dedup.md | partial (`ignoring` shipped) | M-T5.12 |
| channels.md | partial | M-T1.10 (realtime), M-T4.4 (brokers), M-T4.9 (caching) |
| contract-typed-resources.md | proposed | M-T4.8 |
| criterion-everywhere.md | superseded (by reified-criteria) | residue → M-T5.4 |
| criterion.md | partial | M-T5.4 |
| cross-stack-static-analysis.md | partial | M-T8.9 |
| database-seeding.md | partial (1–4 shipped) | M-T2.7 |
| dependency-upgrades.md | backlog | M-T9.1 |
| dependent-form-validation.md | resolved/shipped | — |
| deployable-networking.md | proposed | M-T7.4 |
| dispatch-delivery-semantics.md | partial | M-T4.3 |
| document-and-json-hierarchies.md | partial | M-T2.10; elixir residual → M-T6.2 |
| domain-service.md | superseded (by domain-services) | — |
| domain-services.md | shipped (Shape A) | Shape B → M-T5.14 |
| dotnet-tph-emission.md | shipped | id-threading follow-on → M-T5.7 |
| elixir-ecto-and-api-only-backends.md | historical (Ash removal made it the reality) | API-only residue → verify in M-T6.1 |
| elixir-platform-rename.md | shipped | — |
| embedded-frontend-composition.md | partial (core shipped) | M-T7.8; `targets:` deletion → M-T7.3 slice 0 |
| encrypted-at-rest.md | deferred stub | M-T2.11 |
| error-handling-and-failure-sink.md | proposed | M-T1.8 (frontend), M-T5.2 (backend) |
| exception-less.md | partial | M-T5.1 |
| execution-context.md | partial (backbone complete) | M-T3.11 |
| expressible-builtins.md | proposed | M-T3.4 (phases 1–2), M-T3.6 (phase 3) |
| extern-component-escape-hatch.md | partial (React tier 1) | M-T1.4 |
| extern-domain-extension-point.md | partial (Phase 2 landing) | M-T5.11 |
| extern-function-hook-escape-hatch.md | partial | M-T1.4 |
| fable-elmish-frontend.md | superseded by execution (feliz shipping) | polish → M-T1.16 |
| failure-taxonomy.md | proposed (reframe) | M-T5.1, M-T5.2 |
| frontend-acl.md | partial (1–2 shipped) | M-T1.6 |
| frontend-state-management.md | partial | M-T1.9 |
| global-implementation-plan.md | **superseded by this plan** | — |
| go-backend.md | proposed | M-T10.1 (frozen) |
| htmx-server-rendered-frontend.md | deferred | M-T10.5 (frozen) |
| i18n-strings.md | proposed | M-T1.11 |
| i18n.md | proposed | M-T1.11 |
| implementation-plan.md | reference (type-system family) | live tails → M-T5.1, M-T5.3, M-T5.4 |
| implicit-system-composition.md | partial (tiers 1–2 shipped) | M-T5.13 |
| infrastructure-port.md | proposed (usage-pulled; hold) | no mission until a concrete case appears |
| java-backend.md | shipped | — |
| kubernetes-helm.md | shipped (v1) | hardening → M-T7.2 |
| lifecycle-operations.md | partial | M-T5.8 |
| lifecycle-url-style.md | shipped (D-URLSTYLE) | — |
| load-specifications.md | partial | M-T5.4(e) |
| loom-forms.md | partial | M-T1.6 |
| multi-target-proxy.md | approved, unbuilt | M-T7.3 |
| multi-tenancy-design-note.md | largely shipped (design record) | tail → M-T3.7 |
| mutation-testing.md | proposed (parked) | M-T8.8 |
| named-actions-and-stores.md | partial (stages 1+5 shipped) | M-T1.7, M-T1.9 |
| nestjs-backend.md | proposed | M-T10.3 (frozen; needs re-derivation) |
| nextjs-frontend.md | proposed | M-T10.6 (frozen) |
| observability.md | partial (logs shipped) | metrics/traces → M-T7.1 |
| offerability-can-query.md | proposed | M-T3.10 |
| organization-context.md | proposed | M-T3.6 |
| page-derived-bindings.md | shipped | — |
| pagination-design-note.md | shipped (opt-in paged) | DEBT-28 → M-T2.6; UI consumption → M-T1.1 |
| partial-update.md | proposed (blocked on option) | M-T5.3 |
| payload-transport-layer.md | partial | M-T5.3 |
| per-package-output-tree.md | deferred | M-T8.7 (related) |
| phoenix-tph-emission.md | shipped | — |
| php-backend.md | proposed | M-T10.2 (frozen) |
| platform-directory-layout.md | mostly superseded (D-BACKEND-PKG) | React stacks consolidation → M-T9.5 |
| platform-parity-debt.md | **superseded by this plan** (register absorbed) | rows → M-T6.6, M-T6.9, M-T1.9, M-T6.11 |
| platform-realization-axes.md | superseded (two-axis pruning) | `resolvePersistence` wiring → M-T6.10 |
| playground-git-vfs.md | shipped | — |
| policies-supplementary-note.md | reference | asks honored in M-T3.2 |
| production-readiness.md | reference roadmap | §3.3→M-T4.4, §3.4→M-T4.9, §3.5→M-T4.2, §3.6→M-T3.12, §3.9→M-T7.7, §3.10→M-T4.10 |
| projection.md | proposed | M-T4.2 |
| provenance.md | shipped (all 5) | deferred accessors noted in-doc; wire pair → M-T6.12 |
| provenanced-wire-pair.md | proposed | M-T6.12 |
| quickstart-and-day-one-batteries.md | partial | M-T7.5 (dev/deploy), M-T4.6 (batteries), M-T3.12 (saas/identity), M-T3.1 (default-deny) |
| reference-collection-set-semantics.md | shipped (#1590) | — |
| reified-criteria.md | partial | M-T5.4(d) |
| render-expr-target-unification.md | shipped | — |
| reserved-surface-signposting.md | proposed | M-T5.9(a) |
| resource-model-and-source-types.md | partial | M-T4.8 |
| retrieval.md | partial | M-T5.4(e) |
| scaffolded-navigation.md | proposed | M-T1.13 |
| scheduling.md | proposed | M-T4.1 |
| sensitivity-and-compliance.md | partial (1+2-lite) | M-T3.8 |
| server-side-generation.md | proposed (refactors shipped) | M-T8.7 (evaluate with packaging split) |
| source-map-and-debugging.md | partial (§6E remap shipped) | M-T8.1, M-T8.2 |
| src-ir-phase-reveal.md | shipped | — |
| state-controlled-modal.md | shipped | — |
| static-analysis-followups.md | proposed | M-T6.3 (format gates), M-T8.9 |
| storage-and-platform-config-micro-plan.md | reference (partly moot) | residue → M-T2.9 |
| storage-and-platform-config-plan.md | reference (partly moot) | residue → M-T2.9 |
| storage-and-platform-config.md | partial | M-T2.9 |
| surface-redundancy-cuts.md | shipped (#1795) | — |
| tenancy-authorization-final-surface.md | proposed (synthesis) | M-T3.6 |
| terraform-iac-target.md | proposed | M-T7.6 |
| test-layout-and-macro-consolidation.md | shipped | — |
| type-system-overview.md | reference (orientation) | — |
| typed-capabilities.md | shipped (#1388) | OQ#1 tail → M-T5.12 |
| unfoldable-api-derivation-coordination-note.md | reference | M-T5.10 |
| unfoldable-api-derivation.md | partial | M-T5.10 |
| unfoldable-page-scaffolding.md | shipped | index-sentinel residue ⚠ verify → M-T5.15 |
| uniqueness-and-indexes.md | partial (slice 1) | M-T2.8 |
| validation-error-extension.md | shipped | — |
| vanilla-phoenix-foundation.md | partial (slices 0–6) | residue → M-T6.2, M-T6.10 |
| with-implements-split.md | proposed | M-T5.9(b) |
| workflow-and-applier.md | partial (appliers+ES shipped) | M-T4.7; projections → M-T4.2 |
| workflow-instance-views.md | shipped (#1037) | Phoenix OpenAPI defer → M-T6.2 |
| workflow-instance-visibility.md | shipped (#1035) | — |
| workflow-resource-consumption.md | partial | M-T4.8 |

## Plans (`docs/old/plans/`)

| Doc | Status | Open work → missions |
|---|---|---|
| a6.2-behavioral-tier-second-backend.md | in-progress (v1 landed) | M-T9.3 |
| angular-frontend-plan.md | done (banner stale) | — |
| angular-x-id-select.md | in-flight | M-T1.14 |
| auth-agent-prompt.md | reference template | — |
| auth-providers-implementation.md | in-progress (P4 reads remain) | M-T3.1, M-T3.5 |
| authorization-phase3-2.md | done (#1746) | — |
| authorization-phase3.md | done (#1742) | — |
| authorization-phase4-deny.md | design, unbuilt | M-T3.3 |
| backend-packages.md | in-progress (B3+) | M-T9.5, M-T8.7 |
| backend-parity-plan.md | mostly drained ⚠ verify W2/W3/W5 | residue → M-T6.x |
| builder-roadmap.md | living backlog | M-T1.17 |
| capability-stamp-dedup-simulation.md | paper simulation | M-T5.12 |
| codegen-gap-closure.md | wave 1 done; P3 buckets mostly moot (axes removed) | verify residue → M-T6.9 |
| conformance-parity-restoration.md | done | — |
| dap-node-debug.md | milestones 18–27 done | frontier → M-T8.1 |
| debt-02-principal-nonrelational-filters.md | done | — |
| debt-02-python-principal-filters.md | done | — |
| debt-prioritized-backlog.md | **superseded by this plan** | open rows → M-T6.5 (14), M-T6.9 (17/18), M-T5.4 (24), M-T4.7 (26 residue), M-T6.11 (27), M-T2.6/M-T5.4 (28), M-T5.15 (29/30), M-T6.14 (8/12) |
| elixir-eventsourcing-vanilla-plan.md | done (tail verify) | — |
| feliz-frontend-build.md | in-progress | M-T1.16 |
| frontend-acl-implementation.md | phases 1–2 done | M-T1.6 |
| full-review-remediation.md | mostly landed | residue → M-T9.4 |
| global-test-coverage-plan.md | phases 0–1 partial | M-T9.3 |
| java-backend-implementation.md | done | — |
| java-uniform-publisher-s5c.md | in-flight | M-T4.5 |
| lifecycle-audit-todo.md | design-first | M-T3.9 |
| liveview-on-vanilla-port.md | done | — |
| multi-file-source.md | stage A partial | M-T5.13 |
| multi-tenancy-implementation.md | 1a/1b shipped | tail → M-T3.7 |
| multi-tenancy-phase2.md | done | — |
| nested-parts-alignment.md | done (DEBT-15) | — |
| node-criterion-filter-leak.md | in-flight | M-T6.7 |
| node-persist-time-auditing-simulation.md | awaiting sign-off | M-T5.12 |
| non-guid-id-http-params.md | resolved by removal | — |
| optimistic-concurrency-versioned.md | shipped ⚠ banner stale | default-on → M-T3.4 |
| pack-versioning-plan.md | phase 1 done | phase 2 → M-T9.5 |
| packaging-split.md | P0–P2 done; P3-s5 blocked | M-T8.7 |
| per-pack-migration.md | reference companion | — |
| phase-a-platform-expansion-prereqs.md | done | — |
| phoenix-event-delivery-s5a.md | in-flight | M-T4.5 |
| phoenix-op-guards-403-422.md | in-flight | M-T4.5 |
| phoenix-surface-generator-wiring.md | phases 1–5 done | Phase 6–7 → M-T6.1 |
| platform-expansion-roadmap.md | superseded index | open phases → M-T10.x, M-T6.x |
| playground-git-vfs-implementation.md | done | — |
| playground-sandbox-redesign.md | phases 1–2 done | M-T8.6 |
| python-backend-plan.md | done | — |
| python-feature-completeness-plan.md | done | — |
| realization-axes-alignment.md | superseded (two axes) | residue → M-T6.10 |
| realization-axes-rollout.md | superseded | — |
| retrieval-implementation.md | feature-complete; phase 5 active | M-T5.4 |
| runtime-conformance-harness.md | scoping | M-T9.3 |
| runtime-semantics-tier-followups.md | done (RST drained) | RST-4 admin click → M-T9.7 |
| s7-repository-ports.md | done (A+B+C) | — |
| s7-slice-c-dotnet-uow.md | done | HasColumnName bug → M-T6.14 |
| saga-starter-guard-s5b.md | in-flight | M-T4.5 |
| showcase-100-coverage.md | done | bugs → M-T5.15 |
| source-map-debug-kickoff.md | spine shipped | M-T8.2 |
| span-tracking-emission.md | TS/Hono shipped | M-T8.2 |
| stack-versioning.md | superseded reference | — |
| stdlib.md | mostly shipped | tail → M-T5.5 |
| svelte-frontend-plan.md | done | preview deferral → M-T8.10 |
| tph-unionall-and-contains.md | done (pattern 3 dropped) | — |
| type-system-feature-migration.md | substantially shipped | strict-parity + DBT-4/5 → M-T5.x, M-T6.2 |
| typed-capabilities-implementation.md | phases 1–4+6 done | Phase 5 → M-T5.12 |
| vanilla-document-route-a.md | mostly landed | residue → M-T6.2 |
| vanilla-foundation-research.md | historical | — |
| vanilla-foundation-tdd-plan.md | historical | — |
| vanilla-phoenix-gaps.md | **superseded by this plan** (register absorbed) | §6→M-T6.1, §7→M-T6.3, §11c/§12/§13/§14→M-T6.2 |
| vue-frontend-plan.md | done | preview deferral → M-T8.10 |
| workflow-choreographer-seam.md | done | — |
| workflow-debt-backend-parity.md | done | ES instance pages → M-T4.7 |

## Audits (stay in `docs/audits/` — snapshots, not moved)

| Audit | Open findings → missions |
|---|---|
| architecture-weak-spots-2026-07.md | §1→T1, §2→T2, §3→T3/M-T7.1, §4→M-T4.1, §5→T9, §6→M-T6.1/M-T6.4, §7→M-T5.16/M-T8.1 |
| completeness-audit-2026-07.md | stdlib→M-T5.5, reporting/money→M-T2.12, jobs/email→M-T4.1/M-T4.6, pagination→M-T1.1, metrics→M-T7.1, identity→M-T3.12, API versioning → no mission (needs proposal; note here) |
| full-code-review-2026-07.md | #6→M-T5.6, #22→M-T5.16, C-mediums→M-T9.4 |
| generated-code-ddd-review-2026-07.md | S5(d)→M-T4.3, S10 residue→M-T5.11, S4 default-on→M-T3.4, api-grouping→M-T6.13 |
| generated-code-review-2026-06-30.md | SYS-1→M-T6.8 |
| showcase-coverage-bugs.md | BUG-003/004→M-T5.15, BUG-006 verify landed |
| domain-seam-log-parity.md | §3 residue ⚠ stale → M-T6.14 |
| others (backend/frontend parity matrices, execution-context parity, gated-features-inventory, stack-versions, e2e-suite review, pack-equivalence, architecture-review-2026-06, generated-code-review-2026-06, frontend-test-parity, test-parity-generated-backends, proposal-surface-stability) | historical/reference — no open findings |

## Known unmapped items (deliberate)

- **API versioning** (completeness audit) — no proposal exists; whoever picks it up writes one and adds a mission under T5.
- **`infrastructure-port`** — explicitly usage-pulled; no mission until a concrete case.
- **Brownfield adoption** (M-T2.5) is a proposal-writing mission, reflecting that no design exists yet.
