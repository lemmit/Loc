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
| Named `create <name>` / `destroy <name>` bodies on a state-based aggregate emit nothing anywhere | SILENT 🔴 | `loom-ir.ts:563` (`creates?` unconsumed beyond `[0]` on the ES path); drop-detector walks only canonical lifecycle | open — M-T3.16 G1 / M-T5.8 ph3 |
| `projection … on(Event)` with no `channel` folds on node only; the other four silently never subscribe | SILENT 🔴 | `enrichments.ts:1290` early-return vs `typescript/emit/routes.ts:120` | open — B20, needs a semantics decision |
| `when` gate emitted only at the aggregate route — workflow/extern callers bypass it | SILENT | M-T6.38 note; node `whenGateLine`, .NET `MarkTrackedHandler` | open — owner decision needed |
| Files-route absent-object 404 is a fourth envelope (none RFC 7807) | SILENT (contract) | `elixir/vanilla/files-controller-emit.ts:68`, `python/files-routes-builder.ts:72`, `dotnet/emit/program.ts:238`, `java/emit/program.ts:443` | open — S/M |
| Cross-context `domainService` repo read emits unresolved/uncompilable code (elixir + node at least) | SILENT 🔴 | `elixir/domain-service-emit.ts:428` guard never fires (`readingIsSingleContext` tests the merged context) | open — shared-lowering root |
| `retrieval … loads:` parsed, rejected everywhere | MATURITY | `query-checks.ts:277` `loom.retrieval-loads-unsupported` | by design (successor: per-op autoload) |
| `unsupported-register.ts` overstates ~20 of 37 gap rows (sets long since full) | register hygiene | e.g. `event-sourcing-backend-unsupported` prose | open — S, docs/register only |

## Per backend

- **node (Hono)** — mikroorm crashes on scalar-collection fields (`tags: string[]`), its own throw text says "validator gap" (`emit/mikroorm.ts:206`) → **gated this session**; mikroorm/dapper residue (hierarchical tenancy, find-predicate subsets, declared `migration` blocks — `SELF_PROVISIONING_ADAPTERS`) is HONEST and largely CLAIMED (#2613, #2616, #2621–#2623); only backend with `mountsUi: false` (`platform/metadata.ts:166`) — HONEST/M.
- **dotnet** — dapper aggregation over document/eventLog sources permanently gated (raw-SQL limit, `dapperQueryProjectionGap`); dapper decimal-avg hotfix in flight (#2631). Otherwise converged.
- **java** — reserved-word columns emitted unquoted (compiles, 500s at runtime) — SILENT, **CLAIMED #2627**; `validateJavaReadModelShapes` is a defensive backstop believed unreachable (verify-or-delete candidate).
- **python** — no realization axes at all (no `directoryLayout:` menu, no second persistence adapter) — MATURITY (`adapter-metadata.ts` has no python key); projection-source filter drop fixed this session (shared root).
- **elixir (vanilla Phoenix)** — `shape: document` op/find residue HONEST (`VANILLA_DOC_CRUD_OPS`, `system-checks.ts:1626`), filters/write-seam slice **CLAIMED #2625**; no SSE wire **CLAIMED #2624**; audited-op snapshot dumps the raw Ecto struct (snake keys, timestamps) — SILENT, open (`vanilla/audit-emit.ts:213`); authored `precondition` messages lost on the raise path (prefix-routed rescue) — PARTIAL, open; op self-call restricted to tail position — HONEST (`loom.vanilla-op-call-position`); ES aggregates with ref collections keep the raw serializer — PARTIAL, open.

## Per frontend

- **HEEx (LiveView render path)** — component-local `state` + component-level named `action` silently dropped (only store-mutating handlers hoist; click → `FunctionClauseError`) — SILENT 🔴, open (`liveview-emit.ts:562`); parameterised action→action call and unrecognized `match await` subjects render as no-op `tap` markers — SILENT, open (`heex-walker-core.ts:1850,1932`); layout primitives semantically inert (`Grid`≡`Stack`, bare `div`s) — PARTIAL, open (`heex-primitives.ts:1240`); non-server-paged `Table` gets no pager; `i18nFormat` wrapper dropped (documented degrade); `DataGrid` — the one pinned HONEST heex gap (settled).
- **react / vue / svelte / angular** — converged except the shared-walker items below. Angular/Feliz user components silently vanish on deferred shapes (optional/`slot`/`action` params, page-scope `derived`, async-effect action) with no `loom.*` code — SILENT, open (`feliz/component-emit.ts:152`, `angular/components-emit.ts:42`).
- **feliz** — codegen crash on collection ops in store actions (validator hole) → **gated this session**; crash on `match` without `else` in value position → **fixed this session**; zero-param `WorkflowForm` renders nothing → **fixed this session**; missing-`ui:` deployable raw-crashes → **gated this session**; parameterised repository `find` reads emit dangling Model fields — SILENT, open (`feliz-target.ts:343`); `.map(λ)` HONEST (no lambda seam); component-host `match await` HONEST (`loom.feliz-async-effect-unsupported`); persist ladder **CLAIMED #2614**.
- **flutter** — page-level `derived` rendered as a literal Dart-source string on screen → **fixed this session**; store-action collection ops → **gated this session**; component with `match await` silently vanishes → **gated this session**; degradation comments rendered as visible `Text(...)` → **fixed this session**; missing-`ui:` deployable emits a placeholder app → **gated this session**; form-field drops (nested VO, VO arrays with non-scalar subfields, bool/enum element arrays) only visible as emitted comments — PARTIAL, open (pinned in `parity-freeze.test.ts`); auth ui / SSE / ProvenanceInfo / persist ladder **CLAIMED #2619**; `DataGrid` — settled non-goal.
- **all six + HEEx** — bare enum-value refs in page bodies emit `/* unresolved */ undefined` → **fixed this session** (walker-core arm + lowering stamp; the qualified `Enum.Value` form too; HEEx's pre-existing arm became reachable and its snake-cased atom — a would-be silently-false `Ecto.Enum` comparison — was corrected to declared casing); only `map` of 17 stdlib collection ops usable in page bodies — HONEST, the largest remaining page-DSL gap (`FRONTEND_RENDERED_COLLECTION_OPS`, `ui-checks.ts:330`); `page.requires` never walked by `validateCurrentUserNeedsAuthUi` → **gated this session**; realtime `toast(<expr>)` message subset unvalidated (renderers throw outside a small subset) — open, S; `Grid` children dropped on procedural packs → **fixed this session**; `primitive-modal-controlled` pinned by no RequiredSet → **fixed this session**.

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
