# Language-gap audit, grouped by target — 2026-08-23

Snapshot taken on `main` @ `e98e3af`. As always: **when this prose and the code
disagree, the code wins.** Classification follows the parity discipline —
**SILENT 🔴** (valid `.ddd` passes validation, then mis-emits / crashes codegen /
drops behavior), **HONEST** (a `loom.*` validator gate refuses it), **PARTIAL**
(a slice emits, the rest gated or missing), **MATURITY** (designed, unshipped).
"CLAIMED #N" marks gaps an open PR already covers — do not duplicate them.

**Headline:** the classic backend gate sets have fully converged — every one of
`EVENT_SOURCING_*`, `PROVENANCE_BACKENDS`, `TPH_CAPABLE`, `FIELD_MASK_BACKENDS`,
`AUDIT_*_BACKENDS`, `SUPPORTED_{PAGED,UNION,WHEN,RETURN}_BACKENDS`,
`PROJECTION_*_SUPPORTED`, `LIMITED_FAMILIES`, `STAMP/GUARD_FAMILIES`,
`CHART_FRAMEWORKS`, `PROJECTION_READ_FRAMEWORKS` names all five backends (resp.
all shipping frontends). The remaining debt lives in (a) validator *holes* the
gates never covered, (b) the two newest frontends (feliz, flutter), (c) the HEEx
parallel engine, and (d) per-adapter (dapper/mikroorm) residue.

## Cross-target (all 5 backends)

| Gap | Class | Evidence | Status |
|---|---|---|---|
| Query-time projection `where` never queryability-checked → node crash, node+python **silent filter drop**, dotnet/java/elixir uncompilable output | SILENT 🔴 | no `firstNonQueryableNode` call in `projection-checks.ts`; drop sites `hono/v4/projection-query-routes-builder.ts:130`, `python/query-projections-builder.ts:80` | **fixed this session** |
| Projection-row member typing types fields as string → arithmetic lowers as string concat (`where` AND the fully-silent `select` path, all five backends) | SILENT 🔴 | root cause: missing projection arms in `lower-expr.ts` `memberType`/`stepInto` + the candidate-alias branch | **fixed this session** |
| Named `create <name>` / `destroy <name>` declarations | HONEST (re-audited) | `loom.named-lifecycle-dropped` (`structural-checks.ts`, `validateNamedLifecycleDropped`) refuses the whole declaration; the ES `creates[0]` exemption verified genuinely emitted on all five | wave-2 re-verify: **already gated on HEAD** — remaining work is the emission (M-T5.8 ph3) |
| `projection … on(Event)` with no `channel` folds on node only; the other four silently never subscribe | SILENT 🔴 | `enrichments.ts:1290` early-return vs `typescript/emit/routes.ts:120` | open — B20, needs a semantics decision |
| `when` gate emitted only at the aggregate route — workflow/extern callers bypass it | SILENT | M-T6.38 note; node `whenGateLine`, .NET `MarkTrackedHandler` | open — owner decision needed |
| Files-route absent-object 404 was a per-backend envelope (node broken too; .NET's was a misleading `UseStatusCodePages` backfill) | SILENT (contract) | all five route sites + new `test/conformance/files-absence-envelope-parity.test.ts` | **fixed this session (wave 2)** — one RFC 7807 envelope on all five, pinned outside the `httpStatus` remap |
| Cross-context `domainService` repo read/write mis-emitted on ALL FIVE backends (dangling symbol) | SILENT 🔴 | corrected root cause: `lower-domain-service.ts:33` builds `serviceRepos` context-locally, so the read never lowers to a port | **gated this session (wave 2)** — `loom.domain-service-cross-context-read`; no legal cross-context surface exists |
| `retrieval … loads:` parsed, rejected everywhere | MATURITY | `query-checks.ts:277` `loom.retrieval-loads-unsupported` | by design (successor: per-op autoload) |
| `unsupported-register.ts` overstated ~20 of its gap rows (sets long since full) | register hygiene | 34 of 39 rows rewritten with fresh citations; latent seams labeled; all 47 `site` pointers recomputed | **fixed this session (wave 2)** |

## Per backend

- **node (Hono)** — mikroorm crashes on scalar-collection fields (`tags: string[]`), its own throw text says "validator gap" (`emit/mikroorm.ts:206`) → **gated this session**; mikroorm/dapper residue (hierarchical tenancy, find-predicate subsets, declared `migration` blocks — `SELF_PROVISIONING_ADAPTERS`) is HONEST and largely CLAIMED (#2613, #2616, #2621–#2623); only backend with `mountsUi: false` (`platform/metadata.ts:166`) — HONEST/M.
- **dotnet** — dapper aggregation over document/eventLog sources permanently gated (raw-SQL limit, `dapperQueryProjectionGap`); dapper decimal-avg hotfix in flight (#2631). Otherwise converged.
- **java** — reserved-word columns emitted unquoted (compiles, 500s at runtime) — SILENT, **CLAIMED #2627**; `validateJavaReadModelShapes` is a defensive backstop believed unreachable (verify-or-delete candidate).
- **python** — no realization axes at all (no `directoryLayout:` menu, no second persistence adapter) — MATURITY (`adapter-metadata.ts` has no python key); projection-source filter drop fixed this session (shared root).
- **elixir (vanilla Phoenix)** — `shape: document` op/find residue HONEST (`VANILLA_DOC_CRUD_OPS`, `system-checks.ts:1626`), filters/write-seam slice **CLAIMED #2625**; no SSE wire **CLAIMED #2624**; audited-op snapshots now project through `wireShape` via `<App>.Audit.Wire` (unmasked per authorization.md §5) — **fixed this session (wave 2)**; ES aggregates with ref collections use the wire serializer with an ES-specific `__ref_ids/1` — **fixed (wave 2)**, also reconciling the controller with its own OpenAPI schema; handler `return`s of `datetime`/`decimal`/bare VOs now serialize per declared type instead of dumping struct maps (the reachable slice of the controller-serialize residue; workflow-state structs proved unreachable) — **fixed (wave 2)**; authored `precondition` messages lost on the raise path (prefix-routed rescue) — PARTIAL, open; op self-call restricted to tail position — HONEST (`loom.vanilla-op-call-position`).

## Per frontend

- **HEEx (LiveView render path)** — component-local `state` + named `action`s now lift into namespaced host-LiveView assigns with every handler hoisted (transitive through nested components; multi-instance stateful components and event-name collisions raise honestly) — **fixed this session (wave 2)**; parameterised action→action calls inline with argument substitution and unrecognized `match` subjects raise at codegen instead of `tap` no-ops — **fixed (wave 2)** (a `loom.heex-match-subject-unsupported` validator gate is the follow-up home); forms/queries/uploads/table-controls INSIDE a component still degrade silently (same class, different accumulators) — SILENT, open, the clean follow-up slice; layout primitives semantically inert (`Grid`≡`Stack`, bare `div`s) — PARTIAL, open (`heex-primitives.ts:1240`); non-server-paged `Table` gets no pager; `i18nFormat` wrapper dropped (documented degrade); `DataGrid` — the one pinned HONEST heex gap (settled).
- **react / vue / svelte / angular** — converged except the shared-walker items below. Angular/Feliz user components vanishing on deferred shapes → **gated this session (wave 2)** — `loom.user-component-deferred-target`, with the matrix re-measured on HEAD (several audited feliz shapes no longer defer; angular's surface is only `slot`/`action(T)` params and input-fed api reads) and linkage tests pinning gate↔degradation agreement.
- **feliz** — codegen crash on collection ops in store actions (validator hole) → **gated this session**; crash on `match` without `else` in value position → **fixed this session**; zero-param `WorkflowForm` renders nothing → **fixed this session**; missing-`ui:` deployable raw-crashes → **gated this session**; parameterised repository `find` reads → **fixed this session (wave 2)** — declaration-driven reads with refetch-on-argument-change (the gap was worse than audited: no wire layer emitted at all); four previously-silent sub-shapes now throw, three flagged as future validator-gate candidates; `.map(λ)` HONEST (no lambda seam); component-host `match await` HONEST (`loom.feliz-async-effect-unsupported`); persist ladder **CLAIMED #2614**.
- **flutter** — page-level `derived` rendered as a literal Dart-source string on screen → **fixed this session**; store-action collection ops → **gated this session**; component with `match await` silently vanishes → **gated this session**; degradation comments rendered as visible `Text(...)` → **fixed this session**; missing-`ui:` deployable emits a placeholder app → **gated this session**; form-field drops (nested VO, VO arrays with non-scalar subfields, bool/enum element arrays) only visible as emitted comments — PARTIAL, open (pinned in `parity-freeze.test.ts`); auth ui / SSE / ProvenanceInfo / persist ladder **CLAIMED #2619**; `DataGrid` — settled non-goal.
- **all six + HEEx** — bare enum-value refs in page bodies emit `/* unresolved */ undefined` → **fixed this session** (walker-core arm + lowering stamp; the qualified `Enum.Value` form too; HEEx's pre-existing arm became reachable and its snake-cased atom — a would-be silently-false `Ecto.Enum` comparison — was corrected to declared casing); only `map` of 17 stdlib collection ops usable in page bodies — HONEST, the largest remaining page-DSL gap (`FRONTEND_RENDERED_COLLECTION_OPS`, `ui-checks.ts:330`); `page.requires` never walked by `validateCurrentUserNeedsAuthUi` → **gated this session**; realtime `toast(<expr>)` message subset → **gated this session (wave 2)** — `loom.toast-message-unsupported` over the exact tri-renderer intersection; `Grid` children dropped on procedural packs → **fixed this session**; `primitive-modal-controlled` pinned by no RequiredSet → **fixed this session**.

## Wave 2 (same session)

Eight follow-up agents drained the unclaimed residue above; outcomes are folded
into the rows ("wave 2"). Re-verification corrections worth recording: the named
create/destroy drop was ALREADY gated on HEAD (`loom.named-lifecycle-dropped` —
the audit row was stale within hours); the domainService root cause was
context-local lowering, not the merged-context guard; elixir's controller
residue was reachable through handler `return`s (datetime/decimal/VO), not
workflow-state structs; node's files-404 was broken too. Still open after wave
2: channel-less projection subscriptions (B20, semantics decision), the `when`
gate bypass (owner decision), HEEx in-component forms/queries/uploads, flutter
form-field drops, elixir precondition messages, and the page-body collection-op
vocabulary.

## Method notes

Six parallel auditors (validator-gate sweep, frontend walker layers, feliz/flutter
depth, elixir+HEEx incl. `vanilla-phoenix-gaps.md` re-verification, roadmap+corpus
exclusions, backend silent-hunt) on `e98e3af`, each classifying via the
silent-vs-honest recipe: gate-set membership → IR-field consumption grep →
throw-reachability, with CLI/`generateCorpusCase` repros for every SILENT claim
(probe artifacts in the session scratchpad). Open-PR wave #2609–#2631 was
subtracted as CLAIMED. Stale rows found closed during re-verification (elixir
seeder, M-T6.21, M-T6.30, §13 actor threading, BUG-003, F1 python filters) were
corrected in their home docs rather than reported as gaps.
