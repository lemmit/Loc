# T6 — Backend parity & generated-code quality

*The core matrix (CRUD/relational/ES/inheritance/audit/tenancy) is genuinely all-5 converged, and `backend-parity-gates.test.ts` ("gated xor emitted") is the strongest anti-rot seam in the repo. What's left is a short residue — but several residues have the WRONG failure mode (silent output or generator crash instead of an honest `loom.*` gate). Converting those is cheap and high-value.*

## M-T6.1 — Phoenix hosts SPA: wire the embed — `done` (PR #1886, verified 2026-07-13) · **L** · P1 ⭐ silent hole
Phase 6 shipped: `platform: elixir` hosting `framework: react|vue|svelte` now emits the real SPA. `src/generator/elixir/vanilla/index.ts` dispatches `generate{React,Vue,Svelte}ForContexts` under `assets/` with `{ apiBaseUrl: "/api", pathPrefix: "assets/", basePath: "/app" }`; `shell-emit.ts` adds the endpoint `Plug.Static` at `/app`, a `SpaController` (root→`/app` redirect + `/app/*` deep-link fallback) behind an `:spa` pipeline, and `renderDockerfile` gets the `embedReact` multi-stage build (`spa-build` → `priv/static/app`). Non-hosting deployables stay byte-identical (all wiring gated on `embedReact && uiName`). Proof: the active `vanilla-embed-react.ddd` fixture `mix compile --warnings-as-errors` (Docker) + the embedded SPA `tsc`+`vite build` both gate in `elixir-vanilla-build.yml`; `test/generator/elixir/vanilla-embed-spa.test.ts` pins the surface. The interim `loom.phoenix-spa-embed-unsupported` gate was not needed — the full embed landed.
Sources: [phoenix-surface-generator-wiring](../old/plans/phoenix-surface-generator-wiring.md) Phase 6, [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §6, D-PHOENIX-SURFACE.

## M-T6.2 — Vanilla-Phoenix gap register drain — `partial` · **M–L** · P2
The remaining rows of the old gap register (re-verified 2026-07-13): **§12 residual** document-shape gate still rejects audited/provenanced ops, collection mutation, derived reads (blocked on shared bug #1765), dereferenced-entity members, paged/union finds — drain or leave honestly gated; **§11c residual** narrowed by #1835 — single-level nested parts now emit child tables on relational elixir, but a part that itself declares `contains` (deep part-in-part) is still gated (`system-checks.ts:1325`); **ES applier statements** still emit `# unsupported applier statement` comments (`workflow-eventsourced-emit.ts:151`, `eventsourced-emit.ts:240`) — the last silent-if-reached fallthroughs (op-body TODOs are gone, dispatch is exhaustive); **§14 tail** audit `wireSnapshot` + `WorkflowsController` `serialize/1` snake_case leak; **§13** LiveView action-button auth not actor-threaded from `socket.assigns`; Phoenix OpenAPI surface for workflow-instance views.
Sources: [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §11c/§12/§13/§14, [vanilla-document-route-a](../old/plans/vanilla-document-route-a.md).

## M-T6.3 — Phoenix output hygiene: `mix format` + Dialyzer gates — `open` · **M** · P2
Generated output fails `mix format --check` on ~53% of files; no Credo/Dialyzer gate. Emitter formatting cleanup first, then the CI gate (`LOOM_PHOENIX_FORMAT` exists — activate); Dialyzer nightly-only. Include Elixir in the per-PR OpenAPI parity boot (currently skipped).
Sources: [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §7, [static-analysis-followups](../old/proposals/static-analysis-followups.md) Slices 1–2.

## M-T6.4 — Java crash gates → honest validators — `open` · **S** · P1 ⭐ wrong failure mode
Three ungated `throw new Error` sites crash codegen on valid `.ddd`: cross-aggregate view `follows` (`java/emit/view.ts`), non-id-typed saga instance fields (`workflow-instances.ts`), non-id projection fields (`projection-reads.ts`). Add `loom.*` validator gates (an afternoon each) — then implement the features on their own schedule.
Sources: weak-spots §6, parity audit findings.

## M-T6.5 — Java `hosts:` fullstack embed (DEBT-14) — `open` · **M** · P3
`loom.java-fullstack-unsupported` — the one backend still gating a React bundle host ⚠ verify (dotnet ships it). Reuses the M-T6.1 pattern.

## M-T6.6 — Python document filters — `open` · **M** · P3
The last capability-filter cell: `filter` on a python `shape(document)` aggregate (in-app blob filtering like node/java do). Principal-on-document stays a design decision — either implement or pin the gate as permanent with a D-tag.
Sources: parity register row 1, DEBT-02 residue.

## M-T6.7 — Node criterion filter leak — `done` (verified 2026-07-13) · —
Fixed on `main`: `src/generator/typescript/repository-find-builder.ts:587` combines `filterPred` into the `run<Name>` path. Kept briefly as the record; delete next refresh.

## M-T6.8 — SYS-1: update-path wire validation — `open` · **M** · P1
`UpdateXRequest` DTOs carry no constraints on any backend (create-path does) — invalid updates reach the domain floor. All-backend parity slice (OpenAPI lockstep forces one PR).
Sources: [generated-code-review-2026-06-30](../audits/generated-code-review-2026-06-30.md) SYS-1.

## M-T6.9 — Adapter subsets: Dapper/MikroORM — `partial` · **L** · P3
Both alternates reject big model slices (inheritance, nested parts, non-relational shapes, filters/provenance on mikroorm; seeds/subscriptions on dapper) and Dapper emits `NotImplementedException` stubs for out-of-subset predicates. Either drain the biggest rejections or declare the v1 subsets final (D-tag + docs), stopping the drip. The removed style/transport/runtime registries (2026-07-12) already resolved DEBT-21/22/25 — don't resurrect.
Sources: DEBT-17/18, parity register adapter sub-matrix.

## M-T6.10 — Vanilla as a first-class adapter + `resolvePersistence()` — `open` · **M** · P3
`elixir/index.ts` short-circuits instead of routing through the persistence-adapter registry; `resolvePersistence()` is defined but uninvoked (raw key-branch at 14 dotnet sites). Mechanical alignment so the two surviving axes (`persistence:`, `directoryLayout:`) flow through one seam.
Sources: global-plan T2.d, [platform-realization-axes](../old/proposals/platform-realization-axes.md) residue.

## M-T6.11 — Reserved `PlatformSurface` hooks (DEBT-27) — `blocked(T3/T4 features)` · — · P3
`emitAuthGate`/`emitAuditInit`/`emitCompliancePolicy`/`emitTenancyFilter`/`emitI18nAdapter` are no-op hooks with zero implementations. Don't build speculatively — each fills when its owning feature (M-T3.x / M-T1.11) reaches emission. Tracked here so the hooks aren't forgotten or cargo-culted.

## M-T6.12 — Provenanced wire pair — `open` · **M** · P3
Fold provenanced value+lineage into one `Provenanced<T> = {value, lineage}` carrier in `wireShape` so all targets agree (today 3 backends bolt on an extra key). Phases 1–6 incl. the `.value` read-site unwrap via one `ExprTarget` leaf.
Sources: [provenanced-wire-pair](../old/proposals/provenanced-wire-pair.md).

## M-T6.13 — OpenAPI tag grouping — `open` · **S–M** · P3
Doc-level `x-tagGroups` per served `api` across the five backends (design audited + simulated; resolve decision (f) on .NET/Java per-op tags first).
Sources: [api-openapi-tag-grouping](../old/proposals/api-openapi-tag-grouping.md), ddd-review api-grouping gap.

## M-T6.15 — Feliz silent-drop fallthroughs → fail-fast — `open` · **S** · P1 ⭐ wrong failure mode
The Feliz walker silently discards what it can't render into *compiling* F#: `feliz/update-emit.ts:183` replaces any unhandled action statement kind with `// TODO feliz update: <kind>` (only assign/add/remove/let are handled — control flow vanishes), and `feliz/fs-expr.ts:116` replaces any unhandled expression with `(* unsupported *) ()` unit. No `loom.feliz-*` validator exists. Convert both `default:` arms to fail-fast (throw or a `loom.feliz-unsupported` gate) and then implement the kinds worth having. Found by the 2026-07-13 hollow-work audit (M-T9.8).

## M-T6.16 — Honest gates for grammar-only surface — `open` · **M** · P1
The showcase HARD gate's allowlist grew to exempt node kinds that parse but aren't consumed by most backends: `Projection`/`ProjectionOn` (Hono runtime only — v1 slice 2, #1732), `PolicyDecl`/`PolicyReadRule`, `CommandHandler`/`QueryHandler`/`Route`/`HandlerRef` ("grammar+IR slice only" comments, `showcase-completeness.test.ts:76-131`). Pair every allowlisted kind with a positive `loom.*-unsupported` validator on the backends that don't emit it (the M-T5.9(a) signposting mechanism is the natural home), and drop each entry when its emitter lands. Same pass: promote `walker-core.ts:1331`'s guarded `undefined` method-call fallthrough to a generate-time diagnostic, and clear or justify the Vue bodyless-page TODO stub (`vue/index.ts:607`) and the Java `embedded` compile-skip (`corpus-java-build.test.ts:44`).

## M-T6.14 — Small parity leftovers — `open` · **S** · P3
DEBT-12 Phoenix `verify_token` niche; DEBT-08 `envelope` carrier (deferred — no live use; signpost via M-T5.9a); saga/projection EF `HasColumnName` correlation-column bug (from S7 Slice C review); domain-seam log-catalog §3 residue ⚠ partly stale.
