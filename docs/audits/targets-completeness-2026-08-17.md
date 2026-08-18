# Cross-target completeness audit — 2026-08-17

**Snapshot commit:** `origin/main` @ `5b88573b402af6eb78bd25311c7680cc323ceba8`
(_"Card rendered ONE body child and dropped the rest; `Slot` in a page body is now a
placement error (#2567)"_). Audited from branch
`claude/targets-implementation-gaps-2aeoz4` = that commit + one stub doc commit.

**Code wins over prose.** Every cell below was re-derived from the emitters, the
gate sets in `src/ir/validate/checks/`, and — where a claim was load-bearing — by
running the compiler on a scratch fixture and reading the emitted output. Where
this document disagrees with a tracker row, a mission body, a code comment, or an
older audit, **the code is the answer and the prose is the finding** (§C is
entirely made of prose that lost). No claim here is inherited from
`docs/new-plan/`, `docs/old/`, or a previous audit without its own evidence line.

Scope: the five domain-logic backends, the two non-default persistence adapters,
the six frontends plus the Phoenix HEEx render path, and every skip / waiver /
allowlist register that could be hiding a cell.

| Surface | ids audited |
|---|---|
| Backends | `node` (Hono+Drizzle), `dotnet` (ASP.NET+EF), `java` (Spring Boot+JPA), `python` (FastAPI+SQLAlchemy), `elixir` (plain Ecto/Phoenix) |
| Persistence adapters | `dapper` (dotnet), `mikroorm` (node) — against the `efcore`/`drizzle` defaults |
| Frontends | `react`, `vue`, `svelte`, `angular`, `feliz`, `flutter` + the `phoenixLiveView` HEEx render path |

**Legend:** ✓ emits · ✗ gated (validator error, honest) · ⚠ partial · 🔴 **silent**
(no emit and no gate — the correctness class) · N/A not applicable.

The **discipline** is the parity-auditor one: a gap is only *honest* if a `loom.*`
diagnostic fires before codegen. A backend that emits nothing, emits a comment,
emits unbound identifiers, or throws inside the generator is a **silent** cell no
matter how well documented the limitation is elsewhere.

---

## 1. Backend summary matrix

Every row was checked against both halves: the gate set (does the validator refuse
it?) and at least one real emitter per backend (does it actually emit?).

| Feature axis | node | dotnet | java | python | elixir | Gate (source of truth) |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Capability `filter`, relational non-principal | ✓ | ✓ | ✓ | ✓ | ✓ | `LIMITED_FAMILIES` · system-checks.ts:2291 |
| Capability `filter`, relational **principal** | ✓ | ✓ | ✓ | ✓ | ✓ | `supportsPrincipalFilter` · system-checks.ts:2303-2321 |
| Capability `filter` on `shape(embedded)` | ✓ | ✓ | ✓ | ✓ | ✓ | `supportsNonRelationalFilter` · system-checks.ts:2355-2364 |
| Capability `filter` on `shape(document)` | ✓ | ✓ | ✓ | ✓ | **✗** | same set — elixir admitted for `embedded` only (**F18**) |
| `ignoring <Cap>` filter-bypass | ✓ | ✓ | ✓ | ✓ | ✓ | `FILTER_BYPASS_FAMILIES` · system-checks.ts:2517 (adapter hole: **F1**) |
| `shape(document)` persistence | ✓ | ✓ | ✓ | ✓ | ⚠ scalar scope | `loom.vanilla-document-unsupported` · system-checks.ts:1793-1840 (**F19**) |
| `shape(embedded)` / `relational` persistence | ✓ | ✓ | ✓ | ✓ | ✓ | `PLATFORM_SAVING_SHAPES` · platform-axes.ts:25-37 + the elixir `document` widening at system-checks.ts:1571-1573 |
| Event-sourced aggregate (`persistedAs: eventLog`) | ✓ | ✓ | ✓ | ✓ | ✓ | `EVENT_SOURCING_BACKENDS` · system-checks.ts:3704 |
| Event-sourced **workflow** | ✓ | ✓ | ✓ | ✓ | ✓ | `EVENT_SOURCING_WORKFLOW_BACKENDS` · system-checks.ts:3744 (**F36** — the mission that calls this unbuilt is stale) |
| TPH inheritance | ✓ | ✓ | ✓ | ✓ | ✓ | `TPH_CAPABLE` · system-checks.ts:3656 |
| Provenanced fields | ✓ | ✓ | ✓ | ✓ | ✓ | `PROVENANCE_BACKENDS` · system-checks.ts:3770 (elixir `document` path excepted, system-checks.ts:1789-1791) |
| Per-operation `audited` | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_OP_BACKENDS` · system-checks.ts:3920 |
| Audited **lifecycle** (`create`/`destroy`) | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_LIFECYCLE_BACKENDS` · system-checks.ts:3921 |
| `mask unless` field read-redaction | ✓ | ✓ | ✓ | ✓ | ✓ | `FIELD_MASK_BACKENDS` · system-checks.ts:3825 |
| Paged `queryHandler` | ✓ | ✓ | ✓ | ✓ | ✓ | `PAGED_QH_SUPPORTED` · system-checks.ts:112 |
| Query-time projection | ✓ | ✓ | ✓ | ✓ | ✓ | `PROJECTION_QT_SUPPORTED` · system-checks.ts:122 |
| Projection whole-table aggregation | ✓ | ✓ | ✓ | ✓ | ✓ | `PROJECTION_AGG_SUPPORTED` · system-checks.ts:136 |
| Projection `group by` | ✓ | ✓ | ✓ | ✓ | ✓ | `PROJECTION_GROUPBY_SUPPORTED` · system-checks.ts:172 |
| Projection sourced from a workflow | ✓ | ✓ | ✓ | ✓ | ✓ | `PROJECTION_WF_SOURCE_SUPPORTED` · system-checks.ts:258 |
| Projection sourced from a projection | ✓ | ✓ | ✓ | ✓ | ✓ | `PROJECTION_PROJ_SOURCE_SUPPORTED` · system-checks.ts:294 |
| Generic carriers (`paged<T>`, `envelope<T>`) | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_PAGED_BACKENDS` · structural-checks.ts:329 |
| Discriminated unions | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_UNION_BACKENDS` · structural-checks.ts:503 |
| `when` canCommand gate + `can_<op>` probe | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_WHEN_BACKENDS` · structural-checks.ts:572 (**route layer only** — 🔴 off-route, **F7**) |
| Operation union returns (`op(): X or NotFound`) | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_RETURN_BACKENDS` · structural-checks.ts:604 |
| Typed in-system `api` call (client) | ✓ | ✓ | ✓ | ✓ | ✓ | `REMOTE_API_OP_UNSUPPORTED` = ∅ · system-checks.ts:3282 |
| Per-context integration test emission | ✓ | ✓ | ✓ | ✓ | ✓ | `INTEGRATION_BACKENDS` · language/validators/test-placement.ts:42 |
| `timerSource` scheduling | ✓ | ✓ | ✓ | ✓ | ✓ | no platform gate in timer-checks.ts; five emitters |
| Channels (redis / rabbitmq / kafka) | ✓ | ✓ | ✓ | ✓ | ✓ | `_channels/bindings.ts:71-78`; narrowing is delivery×retention only (`SHIPPED_COMBOS`, util/channels.ts:46-53) |
| Resource kinds (7 sourceTypes) | ✓ | ✓ | ✓ | ✓ | ✓ | registry `util/source-types.ts:180-254`; per-backend `adapters/resource-clients.ts` |
| `extern` / `criterion` / `domainService` | ✓ | ✓ | ✓ | ✓ | ✓ | only shape gates; all target-agnostic |
| Realtime **SSE wire** (backend side) | ✓ | ✓ | ✓ | ✓ | **N/A ⚠** | `backendServesRealtime` · ir/util/channels.ts:14-18 — elixir absent; consumer check is **warning-only** (**F20**) |
| First-boot `seed` datasets | ✓ | ✓ | ✓ | ✓ | **🔴** | no gate; no elixir emitter (**F8**) |
| Resource-op in an aggregate op/guard body | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | no gate anywhere (**F5**) |
| `httpStatus NotFound -> N` override honoured | ✗ | ✗ | ✗ | ✗ | ✓ | `openapi-errors.ts:79-97` deliberately skips the 404 rung (**F26**) |
| Java read-model entity-field shapes | N/A | N/A | ✗ | N/A | N/A | `loom.java-{workflow-instance,projection}-field-unsupported` — unreachable backstop (**F29**) |
| Elixir op-self-call position | N/A | N/A | N/A | N/A | ✗ | `loom.vanilla-op-call-position` · system-checks.ts:1901-1928 (**F19**) |

**Headline:** of the 24 cross-backend gate sets in the tree, **every
backend-capability set is now a full 5/5**. Not one of the classic parity axes
(unions, carriers, `when`, returns, ES aggregate *and* workflow, TPH, provenance,
audit op *and* lifecycle, field mask, all four projection variants, paged handlers,
filter bypass, relational and embedded capability filters) has a missing cell, and
each was spot-verified against a named emitter rather than taken from the set
literal. The residue is: **one** honest platform exclusion (elixir × `document`
capability filters), three elixir-only narrowings, one unreachable Java backstop,
one warning-only realtime cell — and **six silent cells that live outside the gate
sets entirely** (F5, F7, F8, F9, F26 as a wire divergence, plus the adapter cells
in §2).

---

## 2. Adapter sub-matrix

The adapter axis multiplies the matrix again and is where the live debt now is.
`dapper` and `mikroorm` are the two non-default adapters; `efcore` / `drizzle` are
the baselines they are measured against.

| Axis | `dotnet` + `dapper` | `node` + `mikroorm` | Evidence |
|---|:---:|:---:|---|
| Query-time projection, repository/workflow/projection-sourced arms | ✓ | ✓ | dotnet/query-projection-emit.ts:314-337,499-546,686-777; hono/v4/emit.ts:688 |
| Query-time projection, **direct-table** arm over a column-less source | ✗ | ✓ | `loom.dapper-unsupported#feature` · system-checks.ts:2731-2747 + shared classifier ir/util/query-projection-arm.ts:75-102 |
| Direct-table aggregation applies capability `contextFilters` | 🔴 | 🔴 | drizzle + mikroorm both omit them (**F6**) |
| Hierarchical (deep/global) tenancy scope | ✗ | ✗ | system-checks.ts:2871-2887 (scans `contextFilters` **and** `writeScopeFilter`) / :3006-3013 (`contextFilters` only) |
| `policy { deny read }` sentinel | ✓ (`1 = 0`) | **🔴 crash** | dapper.ts:712,740-763 vs no `authz-filter` arm in mikroorm.ts → throw at :1104 from the unguarded call site :1695 (**F2**) |
| `writeScopeFilter` pre-guard on `getById` | ✓ dapper.ts:1121-1136 | **🔴 absent** | zero references across 3033 lines of mikroorm.ts (**F3**) |
| `ignoring <Cap>` bypass honoured | **🔴 ignored** | ✓ | dapper.ts:1073-1098 splices filters unconditionally (**F1**) |
| MigrationsIR chain applied | **🔴 skipped** | **🔴 skipped** | dotnet/index.ts:983 `!usingDapper`; hono/v4/emit.ts:1030 `!usingMikro` (**F4**) |
| Find-predicate subset vs baseline | ✓ full | ⚠ narrowed | `DAPPER_SUBSET = FULL_SUBSET` (find-predicate-capability.ts:94) vs `MIKROORM_SUBSET` :105-136 |
| — `currentUser.<claim>` in a find predicate | ✓ | ✗ *(over-gated)* | rejected at :129-133 although mikroorm.ts:1027-1034 renders it (**F24**) |
| — `startsWith`/method-call predicate | ✓ | ✗ | :125 falls through; `MIKRO_SKIP[prefix-filter]` |
| Nested parts on an abstract inheritance base | ✓ *(ungated, unverified)* | ✗ | system-checks.ts:3071-3078, mikroorm-only (**F25**) |
| Saving shapes | ✓ (dead reject at :2784-2790) | ✓ | the `SavingShape` union has exactly the three values the condition exempts |
| Realtime SSE / outbox / timers / channels / seeds | ✓ | ✓ | all five M-T6.23 rejects closed — emitters cited in §F24 |
| Behavioural leg | ✓ api + unit | ⚠ api only | run-dapper.mjs:188-207 vs run-mikroorm.mjs:338 (justified — the unit tier is persistence-independent) |

**Headline:** the two adapters now reject only **four** things between them
(dapper: column-less direct-table projections, deep-scope tenancy; mikroorm:
deep-scope tenancy, abstract-base parts) — but they carry **five of the audit's
silent cells** (F1–F4, F6). The adapter axis is where the gate sets are
*family*-level and the emitters are *adapter*-level, and every one of these five
lives in exactly that seam.

---

## 3. Frontend matrix

| Axis | react | vue | svelte | angular | feliz | flutter | HEEx (phoenixLiveView) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Primitives accepted by the validator | 58 | 58 | 58 | 58 | 58 | 58 | 58 |
| Registry renderers | 56 `tsx` | via `tsx` | via `tsx` | via `tsx` | 47 procedural | 45 procedural | 56 `heex` |
| Missing renderers | `Tab`,`Column` (sub) | ditto | ditto | ditto | none (required set 45) | none (required set 43) | `DataGrid`, `Tab` |
| Misplaced sub-primitive (`Tab`/`Column` at top level) | 🔴 | 🔴 | 🔴 | 🔴 | — | — | 🔴 |
| `WalkerTarget` required seams (25) | 25/25 | 25/25 | 25/25 | 25/25 | own table | own table | shim (`unreachableExprLeaves`) |
| Expression-leaf table pinned complete | ✓ `jsExprLeaves` | ✓ | ✓ | ✓ | ✓ `FS_LEAVES` | ✓ `DART_LEAVES` | N/A (parallel engine) |
| Design packs (families/versions) | 4 / 8 | 2 / 2 | 2 / 2 | 3 / 3 | procedural | procedural | 2 / 2 |
| Required-emit set size | 72 | 72 | 72 | 52 | 45 | 44 | 10 (shell-only) |
| `Chart` | ✓ per-pack | ⚠ shared template | ⚠ shared template | ⚠ shared template | ✓ | ✓ | ✓ |
| `DataGrid` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ gated | ✗ gated |
| `Timeline` | ✓ | ✓ | ✓ | ✓ | 🔴 | 🔴 | ✓ |
| `ProvenanceInfo` | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠ pinned degrade | — |
| `FileUpload` standalone | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `File` **form field** | ✓ | ✓ | ✓ | ✓ | 🔴 text input | 🔴 text input | ✓ |
| `File` aggregate field → wire model | ✓ | ✓ | ✓ | ✓ | ✓ | 🔴 non-parsing Dart | ✓ |
| User component with reads | ✓ | ✓ | ✓ | ✓ | 🔴 | 🔴 | ✓ |
| User component with `state` | ✓ | ✓ | ✓ | ✓ | 🔴 | ✓ | ✓ |
| User component with `derived` | ✓ | ✓ | ✓ | ✓ | 🔴 | 🔴 | ✓ |
| Stores | ✓ | ✓ | ✓ | ✓ | ✓ (Elmish fold) | ✓ (Riverpod) | ✓ |
| Store `persist: local\|session\|url` | ✓ | ✓ | ✓ | ✓ | 🔴 | 🔴 | ✗ gated |
| Cross-store action composition | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ gated |
| `match await` async effect | ✓ | ✓ | ✓ | ✓ | ⚠ page+instance-op only | ✓ (page) / 🔴 (component) | ✓ |
| Realtime | ✓ SSE | ✓ SSE | ✓ SSE | ✓ SSE | ✓ SSE | ✗ warn-only | ✓ native |
| `auth: ui` guard | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ gated | ✓ |
| i18n `t()` runtime | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Behavioural full-stack leg | per-PR | nightly | nightly | nightly | nightly | **none** | **none** |

Sources for this table: `util/walker-primitive-names.ts:32-101`,
`_walker/registry.ts:244-744`, `_walker/target.ts:541-1415`,
`_packs/required-primitives.ts:249-390`, `feliz/pack.ts:906-959`,
`flutter/pack.ts:714-768`, `system-checks.ts:103,339,416-424,471-483,619-696`,
`store-checks.ts:230-372`, and the empirical sweeps recorded in §D.

**Headline:** the six frontends are far more uniform than the trackers imply —
**all six plus HEEx emit an i18n `t()` runtime**, both alternative frontends cover
their entire required-emit set with real renderers (feliz 47 vs 45 required,
flutter 45 vs 43), both missing-renderer sentinels are dormant, and a 45-cell
sweep of 4 frameworks × 15 pack versions × 3 showcase UIs emitted zero fallback
markers. The honest gaps are correctly gated (flutter `auth: ui`, flutter/HEEx
`DataGrid`, LiveView store lifetime and cross-store, feliz async-effect, flutter's
four form-field shapes with loud drop markers). What remains is **eight silent
cells concentrated on feliz/flutter and one shared across all four JSX targets**
(F11–F17).

---

## 4. Ratchet-list inventory

Every skip / waiver / allowlist register in the tree, with each entry classed
**live** (still reproduces — keep) or **stale** (the thing it names is fixed —
delete, which re-arms real coverage).

| Register | Location | Entries | Verdict |
|---|---|:--:|---|
| `TS_COMPILE_SKIP` | corpus-tsc-build.test.ts:28 | 0 | drained |
| `DOTNET_COMPILE_SKIP` | corpus-dotnet-build.test.ts:39 | 0 | drained |
| `JAVA_COMPILE_SKIP` | corpus-java-build.test.ts:37-41 | 0 | drained |
| `PYTHON_COMPILE_SKIP` | corpus-python-build.test.ts:37-45 | 0 | drained |
| `ELIXIR_COMPILE_SKIP` | corpus-elixir-build.test.ts:51-54 | 0 | drained — **but unregistered in the allowlist ratchet** (F41) |
| `DAPPER_COMPILE_SKIP` | corpus-dotnet-dapper-build.test.ts:52 | 0 | drained |
| `DAPPER_UNSUPPORTED` | corpus-dotnet-dapper-build.test.ts:69-76 | 1 | **live** — `tenancy-hierarchy`, honest (`#deep-scope`) |
| `MIKRO_SKIP` | run-mikroorm.mjs:123-144 | 2 | **live** — `prefix-filter`, `policy-deny`; both honest today, both drainable (F24, F2) |
| Corpus manifest backend exclusions | fixtures/corpus/manifest.ts:93 | 1 row, 2 cells | dotnet cell **stale** (F31); elixir cell **live** (F18) |
| `BEHAVIOURAL_SKIP` | behavioral/cases.mjs:283-341 | 4 | 3 **stale** (dapper × projection-aggregation / projection-groupby / read-gates, F32); 1 **live** (elixir `seed-values`, F8). **Unregistered in the allowlist ratchet** (F41) |
| `DAPPER_SKIP` | run-dapper.mjs:267-272 | 0 | drained |
| Wire waivers | `_helpers/wire-waivers.ts:65-72` | 1 | **live** — #2563 .NET `System.Decimal` `avg` truncation (F27) |
| Schemathesis waivers | behavioral/schemathesis-waivers.json | 7 | **all 7 live**; W8 by-design (keep). W1+W7 claimed by #2566; W4/W5/W6/W9 unclaimed (F28) |
| Schemathesis backend legs | run-schemathesis.mjs:119-127 | 1 of 5 | **live structural hole** — node only (F38) |
| `KNOWN_HEEX_GAPS` | heex-parity.test.ts:63-83 | 1 | **live** — `DataGrid`, honest, settled decision |
| `KNOWN_DEGRADATIONS` / `KNOWN_VERBATIM_INTRINSICS` | render-degradation.test.ts:92-130 | 0 / 0 | empty — but **structurally cannot reach** the Timeline/component/sub-primitive drops (F40) |
| `GAPS` (frontend-showcase-render) | frontend-showcase-render.test.ts:40-44 | 0 | empty — matrix omits flutter + phoenixLiveView (F40) |
| `SHOWCASE_EXCLUDED_PRIMITIVES` | showcase-completeness.test.ts:210-244 | 4 | live, each with compensating per-primitive coverage (verified) |
| showcase `ALLOWLIST` | showcase-completeness.test.ts:76-153 | 14 | entries live and justified; the **ratchet's justification comment is stale** (F35) |
| `UNCOVERED` (diagnostic-firing census) | diagnostic-firing-census.data.ts:386+ | 38 | live list; **≥2 provably unreachable** and belong in `UNREACHABLE_PINS` (F35) |
| override-status-census `WAIVERS` | override-status-census.test.ts:501-550 | 4 | **live** — one root cause across node/dotnet/java/python (F26) |
| authz-status-census `FIND_DETAIL` | authz-status-census.test.ts:326-340 | 1 | live, cosmetic (node detail string) |
| `TSX_EXEMPT` (pack testid) | pack-testid-coverage.test.ts:46-59 | 2 | live, structurally justified |
| pipeline-layering `ALLOWED`, dead-generator-exports `ALLOW`, feature-doc `KNOWN_GAPS` | allowlist-ratchet.test.ts:141-153 | 0/0/0 | drained (no-slack check passes) |

**Totals: 88 register entries inventoried across 24 registers — 6 compile-skip maps
fully drained; 4 entries stale (1 corpus manifest cell + 3 behavioural skips); ~19
live entries, of which 12 are honest gates to keep and 7 name real open defects.**

---

## 5. Findings

Ordering: §A silent (correctness), §B honest non-uniform cells, §C prose that lost
to the code, §D coverage/governance. `claimed by #NNNN` marks a gap an open PR
already covers — those are excluded from the fleet plan.

### §A — Silent cells (🔴 no emit, no gate)

#### F1 — `ignoring <Cap>` is silently still filtered on `persistence: dapper`
**Status:** 🔴 silent · dotnet+dapper.
**Evidence:** the bypass gate is *family*-level — `FILTER_BYPASS_FAMILIES`
(system-checks.ts:2517) and `bypassSupported()` (:2523-2527) read only
`dep.platform` — while the Dapper repository splices `agg.contextFilters` into
every SELECT unconditionally (`dotnet/emit/dapper.ts:1073-1098`,
`capabilityFilters → filterSql → andFilter`) with zero occurrences of
`bypassAll`/`bypassCaps` in the file; the only `.IgnoreQueryFilters` call sites are
EF-only (`emit/efcore.ts:672-682`, `find-emit.ts:20-28`).
**Impact:** `find x() ignoring softDeletable` validates and the emitted SQL still
ANDs the bypassed predicate — an admin "include deleted" view that shows nothing
deleted. Wrong answer, no error.
**Fix:** make `bypassSupported` adapter-aware (honest gate, minutes) *and/or* teach
the Dapper repo the bypass set the way `efcore.ts:672-682` does; extend
`backend-parity-gates.test.ts` with an adapter dimension.

#### F2 — `policy { deny read }` crashes codegen on `persistence: mikroorm`
**Status:** 🔴 silent (generator throw) · node+mikroorm.
**Evidence:** enrichment appends the deny sentinel to `contextFilters`
(`enrich/enrichments.ts:706-719` → `ir/util/tenant-stance.ts:402-408`, a childless
`authz-filter` leaf). MikroORM has **no** `authz-filter` arm (0 hits in
`typescript/emit/mikroorm.ts`), so `mikroContextFilters` :1193-1207 takes the
non-principal branch and `whereToMikroFilter` throws at :1104 — from the
**unguarded** call site :1695, unlike the per-find one at :1806-1820.
`validateMikroOrmSupport` rejects only the deep-scope sentinel (:3006).
**Impact:** `ddd generate system` dies with `mikroorm: unsupported find predicate
'authz-filter'` and no `loom.*` code. Every other adapter has the arm (drizzle
`repository-find-predicate.ts:154-199`, dapper `.ts:712/740`, efcore `:730`, java
`render-jpql.ts:123`, python `find-predicate.ts:182`, elixir `render-expr.ts:289`).
**Fix:** add the `authz-filter` arm to `whereToMikroFilter` mirroring dapper's
`1 = 0`; drain `MIKRO_SKIP[policy-deny]`.

#### F3 — `writeScopeFilter` is never consumed on `persistence: mikroorm` (authorization bypass)
**Status:** 🔴 silent · node+mikroorm.
**Evidence:** enrichment sets `writeScopeFilter` for a narrowed write ladder
(`enrichments.ts:659-663`) and for `policy { deny write on X }` (:721-723). Zero
references to it across the 3033-line `emit/mikroorm.ts`; its `getById` is a bare
`findById`+throw (:1989-1993, plus the document/embedded/ES twins at :2310, :2532,
:2751). Drizzle carries the pre-guard (`repository-builder.ts:325-348`), as do
dotnet (`emit/repository.ts:705-716`), dapper (`.ts:1121-1136`), java
(`emit/repository.ts:444-448`), python (`find-predicate.ts:529`), elixir
(`capability-filter.ts:127-142`).
**Impact:** a `deny write` carve-out compiles clean and the mutation's command-load
succeeds — the 404 the seam exists to produce never happens. **This is the most
severe finding in the audit**: a security control that silently does not run.
**Fix:** port the drizzle pre-guard into all four mikroorm `getById` variants;
also widen the mikroorm deep-scope gate (:3006) to scan `writeScopeFilter` the way
dapper's (:2871) does.

#### F4 — Both non-default adapters skip the MigrationsIR chain entirely
**Status:** 🔴 silent · dotnet+dapper, node+mikroorm.
**Evidence:** `dotnet/index.ts:983` `const hasMigrations = !usingDapper && …`;
`hono/v4/emit.ts:1030` `const hasMigrations = !usingMikro && …` (:1038 skips the
provenance migration too). Dapper's schema instead comes from `renderDapperSchema`
(`dapper.ts:2031-2035`, :2248-2265) emitting only `CREATE TABLE IF NOT EXISTS`
(:2080…:2180) at boot; mikroorm's from `orm.schema.updateSchema()` (:1624-1629).
No adapter clause in `validateDapperSupport` / `validateMikroOrmSupport` /
`migration-checks.ts`.
**Impact:** a declared `migration { … }` block (rename / add column / backfill /
raw sql) validates and is then **never applied**. On dapper an added column simply
does not exist at runtime (CREATE-IF-NOT-EXISTS is a no-op against an existing
table); on mikroorm a rename lands as drop+add (**data loss**) and backfill/`sql`
steps never execute. This is exactly the contract `migration-evolution-e2e` proves
for efcore.
**Fix:** minimum — gate honestly (`loom.{dapper,mikroorm}-unsupported#migrations`
when `system.migrations` is non-empty). Real exit — run the chain on both adapters
and add the two cells to `migration-evolution-e2e`.

#### F5 — A resource-op in an aggregate operation/guard body is ungated on all five backends
**Status:** 🔴 silent · all five backends.
**Evidence:** a resource handle is ambient over the whole context —
`ir/lower/lower.ts:1175-1195` builds `resources` from every
`resource { for: <thisCtx> }` into the **one** `Env` aggregates use too;
`lower-expr.ts:1544-1561` resolves the bare name before locals and :672-690 lowers
`<res>.<verb>(...)` to `callKind: "resource-op"`. Renderers only receive the
routing map in workflow/handler contexts, so: dotnet `render-expr.ts:983-996`
**throws**, java :773-782 **throws**, elixir :1041-1053 **throws**; typescript
:498-505 and python :632-637 emit an **unbound** `(await res$verb(...))`. The only
resource-op checks are workflow-scoped (`workflow-checks.ts:1071-1105`).
`docs/resources.md:165` states the rule ("workflows only") — no validator
implements it.
**Impact:** codegen crash on three backends, non-compiling output on two, for a
`.ddd` the validator accepts.
**Fix:** one target-neutral IR check (`loom.resource-op-outside-workflow`) walking
operation / lifecycle / guard bodies; message from `src/diagnostics/messages.ts`.
Mutation-prove it against each of the five renderers' current behaviour.

#### F6 — A direct-table aggregation applies no capability `contextFilters` (drizzle + mikroorm)
**Status:** 🔴 silent · node (both adapters) · roadmap `M-T6.41` (line 108).
**Evidence:** a query-time aggregation projection reads the source table directly
and neither adapter ANDs in the aggregate's capability `contextFilters`;
`mikroContextFilters(agg, bypass)` already takes a bypass set, so the seam exists.
**Impact:** a `softDeletable` source counts soft-deleted rows; a `tenantOwned`
source counts foreign tenants. Silent wrong answer on a number a dashboard shows.
**Fix:** thread `contextFilters` (minus the `ignoring` set) into the direct-table
select on both adapters; assert via a behavioural case that a soft-deleted row does
not move the count.

#### F7 — A `when` state gate is not enforced off the aggregate route
**Status:** 🔴 silent gate bypass · verified on node + dotnet, unverified on
java/python/elixir · roadmap `M-T6.38`.
**Evidence:** the `when` predicate is emitted at the route/handler layer only
(node `routes-builder.ts` `whenGateLine`; dotnet `<Op>Handler.cs`), while a
workflow step / saga cascade / extern `commandHandler` calls the **domain** method
directly, which carries no gate.
**Impact:** a state-gated operation invoked from inside the system runs with the
gate unevaluated — no `DisallowedError`, no 409, the write lands. Absence of a
refusal, not a wrong shape.
**Fix:** move (or duplicate) the gate to the domain-method entry on each backend;
first re-verify the java/python/elixir rows, which the mission marks unverified.

#### F8 — `platform: elixir` emits no seeder — every `seed` dataset is silently dropped
**Status:** 🔴 silent · elixir · roadmap `M-T6.37` · register `BEHAVIOURAL_SKIP.elixir["seed-values"]`.
**Evidence:** `priv/repo/seeds.exs` is only a layout **slot**
(`elixir/adapters/by-feature-layout.ts:66,181-182`) and a doc comment
(`elixir/index.ts:28`); no elixir emitter writes it and nothing reads `ctx.seeds`.
The other four import `_persistence/seed-datasets.ts`
(`{typescript,dotnet,python,java}/emit/seed.ts`).
**Impact:** declared reference data does not exist on elixir — tables boot empty
while four backends seed. Invisible to the compile tier (nothing fails to compile).
**Fix:** an Ecto seeder module — domain rows through the context `create` path
(D-SEED-PATH), raw rows as schema-qualified INSERTs, the `__loom_seed` marker
(D-SEED-IDEMPOTENCY), `LOOM_SEED` gating, invoked at boot beside migrations. Model:
java's `<Ctx>SeedRunner` (`java/emit/seed.ts:106`). **Acceptance = deleting the
`BEHAVIOURAL_SKIP` entry and running `node run-elixir.mjs seeding`.**

#### F9 — A non-paged `find all` + a scaffolded Elixir list page emits a project that will not compile
**Status:** 🔴 silent · elixir · roadmap `M-T6.40`.
**Evidence:** `elixir/liveview-emit.ts:1070` emits
`case ${ctxModule}.list_${aggSnake}s(${listArgs}) do` (4-arity `listArgs`) against
the bare 0-arity `defdelegate` in `vanilla/context-emit.ts`; three call sites.
**Impact:** `mix compile --warnings-as-errors` fails; `.ddd` validates and
generation exits 0.
**Fix:** derive the call arity from the same query-builder facts the context
delegate uses (or emit the paged delegate when the page needs one); gate the
combination if the shapes genuinely cannot meet. Prove with a corpus-elixir compile.

#### F10 — `persistence: dapper` emits unquoted identifiers — a reserved-word column breaks the DDL
**Status:** 🔴 silent (compiles green, boots red) · dotnet+dapper · roadmap `M-T6.41` (line 590).
**Evidence:** `dotnet/emit/dapper.ts` builds
`CREATE TABLE IF NOT EXISTS ${tableOf(agg.name)}` at :2080, :2099, :2145, :2155,
:2171, :2180, :2211 with **no identifier-quoting helper anywhere in the file**.
**Impact:** a field named `order` / `user` / `group` / `end` produces a Postgres
syntax error at boot. The compile tiers are structurally blind to emitted schema.
**Fix:** a `quoteIdent` helper applied at all seven sites, mirroring the
`sql-pg.ts` renderer's quoting. **`schema-load.yml` is the gate that catches it** —
add a reserved-word corpus fixture so it does.

#### F11 — A misplaced sub-primitive (`Tab` / `Column`) silently vanishes on five render paths
**Status:** 🔴 silent · react, vue, svelte, angular, HEEx.
**Evidence:** empirically verified — `body: Stack { Tab("x") }` on a react/vue/
svelte/angular deployable returns `errors: []` from AST validation **and** zero
errors from `validateLoomModel(enrichLoomModel(lowerModel(ast)))`; generation then
emits `{/* Tab: not supported by the React walker yet */}` (JSX) or
`<%!-- Tab: not supported by Phoenix LiveView target --%>` (HEEx) —
`_walker/walker-core.ts:1135-1136`, `elixir/heex-walker-core.ts:1052`, reached
because `registry.ts:737-743` gives the two `group: "sub"` primitives no `tsx`
renderer. Same experiment with `Column("Code", o => o.code)` behaves identically.
**Impact:** author content disappears with no diagnostic. **This is precisely the
class #2567 just closed for `Slot`** (`loom.slot-outside-component`,
`ui-checks.ts:469-491`) — the sub-primitives never got the equivalent placement
gate. Secondary bug: the comment says "the React walker" on vue/svelte/angular.
**Fix:** a placement check in `ui-checks.ts` modelled directly on
`loom.slot-outside-component`: `Tab` only inside `Tabs`, `Column` only inside
`Table`/`DataGrid`. Fix the framework name in the fallback comment. Mutation-prove
by reverting the gate.

#### F12 — An in-form `File` field renders as a plain text input on feliz and flutter
**Status:** 🔴 silent · feliz, flutter · **not claimed by any open PR**.
**Evidence:** feliz — `FelizInputKind` (`feliz/wire.ts:363`) has no file member and
`inputKindFor` (:589-611) sends `File` down `default: return "text"` at :606;
generated `App.fs` carries `blob: string`, `Encode.string form.blob`, a plain
`Html.input`. flutter — `scalarInputKind` (`flutter/forms-emit.ts:183-212`) hits
`default: return "text"` at :208 and `FlutterInputKind` (:88-97) has no file
member, so **no drop marker either**; generated `forms.dart` carries a
`TextEditingController` and `'blob': _blobController.text`. The target backend
requires the object (`z.object({url,key,contentType,size})`). `ddd parse` = 0
errors, 0 warnings on both.
**Impact:** guaranteed 422 at runtime on both alternative frontends.
**Fix:** add a `file` input kind to both tables wired to the existing standalone
`FileUpload` machinery (`feliz/pack.ts:814`, `flutter/pack.ts:678` already do the
upload→`FileRef` round-trip) — or, minimum, add it to flutter's `droppedMarker`
family and feliz's equivalent so it becomes honest. Note
`docs/new-plan/T1-ui-frontend.md:255` says `File` fields "vanish silently" — wrong
in the worse direction; they render and submit a string.

#### F13 — A `File`-typed aggregate field makes Flutter emit non-parsing Dart
**Status:** 🔴 silent · flutter.
**Evidence:** `flutter/dart-model-emit.ts:99-104` `copyWithParam` blindly appends
`?` to `dartType(base(f.type))`, but `dartType` already returns `"FileRef?"` for a
`File` primitive (`dart-types.ts:42`, with an explicit guard at :70-71 saying so).
Emitted `models.dart` lines 58 and 146 read `FileRef?? blob,`. Same file :51 and
:139 emit `'blob': blob.toJson(),` — an unconditional call on a `FileRef?`
receiver (`toJsonEntry` :89-94 keys off the IR `optional` flag, not Dart
nullability). Four non-compiling lines per model. The sibling page-state helper
gets it right (`riverpod-emit.ts:335-347` tests `dt.endsWith("?")`).
**Impact:** `flutter analyze` would fail — except CI never sees it: the
`generated-flutter-build.yml` showcase has a `File` only in page **state**, never
as an aggregate field, so no `FileRef` wire model is ever emitted under analysis.
**Fix:** reuse the `endsWith("?")` test in `copyWithParam` and make `toJsonEntry`
null-aware; **add a `File` aggregate field to the flutter CI fixture** — otherwise
the fix is unguarded.

#### F14 — Store `persist: local|session|url` silently degrades to memory on feliz and flutter
**Status:** 🔴 silent · feliz, flutter.
**Evidence:** flutter — `flutter/store-builder.ts:76-88` emits
`// TODO(flutter full-parity): persist: <x> is not implemented` and builds an
in-memory Riverpod notifier anyway. feliz — **worse**: zero `.lifetime` references
in `src/generator/feliz/*` (stores fold into the single Elmish Model,
`feliz/index.ts:215-243`), so there is not even a TODO in the output.
`store-checks.ts` gates lifetime **only** for LiveView (:230-249).
**Impact:** state is lost on restart and not URL-shareable, with nothing in the
output or the diagnostics saying so.
**Fix:** short term, extend the LiveView lifetime gate to feliz+flutter so it is
honest; then implement `localStorage`/`sessionStorage`/query-param persistence per
target (react/vue/svelte/angular `store-builder.ts:254-319` are the models).

#### F15 — `derived`-bearing user components vanish on feliz + flutter; `state`-bearing ones vanish on feliz
**Status:** 🔴 silent · feliz, flutter · **not claimed by #2568** (which covers the
*read-bearing* case only).
**Evidence:** feliz `component-emit.ts:112-121` `isCandidate` requires
`state.length===0 && derived.length===0 && actions.length===0`; generated `App.fs`
emits `(* unknown layout component: Counter *)` and `(* unknown layout component:
Sum *)`. flutter `component-emit.ts:18-22,129-133` lists a `derived` binding among
the non-threaded shapes; generated `home_page.dart:14` emits
`const SizedBox.shrink() /* unknown layout component: Sum */` — while the sibling
**stateful** `Counter` in the same fixture *did* emit a `StatefulWidget`, proving
this is `derived`-specific on flutter. `ddd parse` = 0 errors, 0 warnings.
**Impact:** an author-declared component renders as nothing.
**Fix:** stack on #2568's component work — extend the candidate predicate to thread
`derived` (a pure function of props: compute in the builder) and, on feliz, `state`
+ `actions` (fold into the Elmish Model like the store path does).

#### F16 — `Timeline` degrades to a comment on feliz and flutter — **claimed by #2569**
**Status:** 🔴 silent · feliz, flutter · claimed by **#2569** (draft, "W3-6:
entity-history `Timeline` reaches heex, feliz, flutter").
**Evidence:** `_walker/primitives/timeline.ts:44-56` has arms for
react/vue/svelte/angular and a `default:` `renderComment`; neither alternative
frontend supplies `renderTimeline`. Emitted: `(* Timeline: not yet supported on
feliz *)` / `const SizedBox.shrink() /* Timeline: not yet supported on flutter */`.
HEEx is already implemented on `main` (`registry.ts:624`), so #2569's HEEx third is
already satisfied.

#### F17 — Read-bearing user components vanish on feliz and flutter — **claimed by #2568**
**Status:** 🔴 silent · feliz, flutter · claimed by **#2568** (ready).
**Evidence:** feliz `component-emit.ts:40-56,112-121`; flutter
`component-emit.ts:18-23,140-151` (`if (!r.hasReads && !r.usesStores)`). Emitted
`(* unknown layout component: OrderList *)` /
`/* unknown layout component: OrderList */` — while the component's strings **are**
extracted into the i18n catalog, so declaration and render site disagree.

### §B — Honest non-uniform cells (✗ / ⚠)

#### F18 — elixir × `shape(document)` capability filters — the one platform hold-out
**Status:** ✗ gated (honest) · elixir.
**Evidence:** `supportsNonRelationalFilter` (system-checks.ts:2355-2364) lists
`elixir && shp === "embedded"` only. Emitter confirmation:
`elixir/vanilla/document-emit.ts` never imports `./capability-filter.js` (six other
elixir modules do), and `repository-emit.ts:84-85` routes document aggregates to a
filter-less `renderDocRepository`. **Proved firing:** rebuilt `out/`, ran
`ddd parse` on a scratch elixir + `shape: document` + `filter !this.archived`
fixture → exactly one `loom.context-filter-unsupported`. The principal variant
(`supportsPrincipalNonRelationalFilter` :2382-2391) is a subsumed second
exclusion — :2445-2452 reports the shape reason first. node/java/python/dotnet all
filter document reads in-app (`typescript/repository-builder.ts:61,81,129`;
`java/emit/document-store.ts:50-58,228`; `python/repository-document-builder.ts:65-73,283`;
`dotnet/emit/repository.ts:694,740,804,817` — the #2530 fix).
**Impact:** none silent; the combination is refused. It is the **only** cell in the
whole gate-set inventory where one backend of five cannot do what the other four do.
**Fix:** in-app filtering on the elixir document read path, mirroring
`java/emit/document-store.ts`; then widen `supportsNonRelationalFilter` and the
corpus manifest's `policy-document` row.

#### F19 — Three elixir-only narrowings inside shapes elixir does support
**Status:** ✗ gated (honest) · elixir.
(a) `validateVanillaDocumentScope` (system-checks.ts:1793-1840,
`loom.vanilla-document-unsupported`) — provenanced-site ops and non-scalar
predicate shapes rejected inside the document shape; returning/audited/containment
ops admitted. (b) `validateElixirOpSelfCallPosition` (:1901-1928,
`loom.vanilla-op-call-position`) — an op-self-call is only allowed as the entire
value of a `return`. (c) The remaining §12/§14 residue tracked by `M-T6.2`.
**Impact:** honest refusals; each is a real feature the other four backends carry.
Not covered by `backend-parity-gates.test.ts`.

#### F20 — elixir serves no SSE realtime wire; the consumer check is warning-only
**Status:** N/A for a LiveView UI, ⚠ for a cross-target one · elixir backend, flutter frontend.
**Evidence:** `backendServesRealtime` (ir/util/channels.ts:14-18) = node/dotnet/
java/python. A LiveView UI is short-circuited by `NATIVE_REALTIME_FRONTENDS`
(system-checks.ts:643) and pushes over its own socket
(`elixir/realtime-liveview.ts`) — legitimately N/A. But an SSE frontend (react/vue/
svelte/angular/feliz) pointed at an elixir backend gets
`loom.ui-realtime-unsupported#backend-serves-no-sse` at **severity warning**
(:672-673); flutter gets the sibling `#frontend-has-no-consumer` warning (:685-696).
**Impact:** the model compiles and the `on <channel>.<Event>` handler is silently
dropped. This is the only backend-capability exclusion in the inventory that does
not hard-fail — a warning is a silent gap wearing a hat.
**Fix:** either emit the SSE wire on elixir (the four other backends' realtime
emitters are the model) and a flutter SSE consumer (`M-T1.18` M-F), or raise both
arms to `error`.

#### F21 — Flutter's three honest frontend exclusions
`auth: ui` (`AUTH_UI_FRAMEWORKS` system-checks.ts:103, error — emitter absence
confirmed: no `AuthGate` in `src/generator/flutter/`, while `feliz/auth-gate.ts`
exists), `DataGrid` (`DATA_GRID_FRAMEWORKS` :339 — settled decision, no Dart
TanStack, `dart:js_interop` is web-only while the shipping target is a native APK;
`Table` is the named alternative), and `FLUTTER_DEFERRED_BUILDER_NAMES` (:721-745,
currently empty — an auto-closing derived gate). HEEx shares the `DataGrid`
exclusion (`KNOWN_HEEX_GAPS`, one entry). All honest; the flutter `auth: ui` cell is
the only one worth closing.

#### F22 — LiveView store lifetime + cross-store; feliz async-effect
`loom.store-lifetime-liveview-invalid` (store-checks.ts:230-249),
`loom.store-cross-store-on-liveview-invalid` (:250-273),
`loom.feliz-async-effect-unsupported` (:305-372, fires for a **component** host
always and for a non-instance-op subject). All three are narrowly-scoped honest
gates — the *good* pattern, and the honest counterpart to F14.

#### F23 — Dapper's residual rejects (and one dead clause)
Two live: the column-less **direct-table** query-time projection arm
(system-checks.ts:2731-2747, sharing the classifier
`ir/util/query-projection-arm.ts:75-102` with the emitter so they cannot drift) and
**deep/global tenancy scope** (:2871-2887). The blanket M-T6.25 refusal is gone and
`DAPPER_SUBSET = FULL_SUBSET`. **The saving-shape reject at :2784-2790 is
unreachable dead code** — the `SavingShape` union has exactly the three values the
condition exempts.

#### F24 — MikroORM's residual rejects, one of them stale
Live and correct: deep-scope tenancy (:3006-3013 — the emitter would *swallow* the
failure at :1193-1205, i.e. a converted silent cross-tenant read) and nested parts
on an abstract inheritance base (:3071-3078). Live but **over-gated**:
`find-predicate-capability.ts:129-133` rejects `currentUser.<field>` "no principal
accessor on the MikroORM find path" — yet `emit/mikroorm.ts:1027-1034` renders
`requireCurrentUser().<claim>` with a body-scan-driven import (:2054-2062,
:2377-2384). The `contains`-membership arm (:122-123) is still real (no join
subquery). All five M-T6.23 feature rejects are closed, **including realtime SSE**
(#2534 confirmed landed) and query-time projections — the doc lead saying otherwise
is stale.

#### F25 — The abstract-base-with-parts gate exists on exactly one adapter
**Status:** breadth · every non-mikroorm adapter.
The reject at system-checks.ts:3071-3078 runs under
`if (dep.persistence !== "mikroorm") continue;` (:2945), and no other gate pairs
`isAbstract` with `parts`/`contains`. The comment at :3067-3070 argues the shape is
"genuinely unmappable" (an abstract base owns no repository; concretes do not
inherit its parts) — if that is true it is true everywhere. **Only the absence of
the gate was verified; what the other emitters produce was not.** Re-verify before
either widening the gate or deleting its justification.

#### F26 — `httpStatus NotFound -> N` is honoured on elixir only
**Status:** ⚠ 4-backend divergence · register: override-status-census `WAIVERS`
(4 entries) · roadmap `M-T5.20` (`partial`).
**Evidence:** `ir/util/openapi-errors.ts:79-97` resolves `ReferencedInUse` /
`DomainError` / `Forbidden` through the `httpStatus` override but deliberately
**not** `NotFound` ("the 404 rung is deliberately NOT resolved here"). The ratchet
is assert-still-broken and passes.
**Impact:** one root cause, four backends: an author's declared 404 override is
ignored. The 404 has two producers and which fires is backend-dependent (hono
throws into `onError`; .NET/java/python bare-return), and the fix has already
regressed once (#2462 reverted the shipped half, #2340 restored it).
**Fix:** route every bare-404 return site on the four backends through
`resolveErrorStatus` and update their declared response sets; drain the four
waivers in the same PR.

#### F27 — `decimal` is `System.Decimal` on .NET and float64 everywhere else
**Status:** ⚠ · dotnet · the single live wire waiver (`wire-waivers.ts:65-72`,
#2563, scoped to `projection-groupby $[*].avgLines`).
**Evidence:** the waiver's two-way ratchet (`wire-record.ts:381-393` fails the leg
when a waiver stops matching) plus a per-PR dotnet behavioural leg on green `main`
prove it still reproduces: `avg` truncates at ~15 significant digits
(`2.33333333333333` vs `2.3333333333333335`).
**Note:** likely overlaps **#2575** (money/decimal follow-ups from #2560) — check
before starting. Exit is a global representation decision (response records +
OpenAPI schema), not a projection-emitter tweak.

#### F28 — All seven schemathesis rules still reproduce (node only)
**Status:** ⚠ · node · `test/behavioral/schemathesis-waivers.json`.
W1 non-JSON `Content-Type` → 500 (every write route reads
`c.req.valid("json")` with no guard; the validator is content-type-keyed so the
handler dereferences `undefined`) — **claimed by #2566**. W7 `z.coerce.*` accepts
`false` for a declared `date-time`/`number` (`routes-builder.ts:2054-2060`; note
body `bool` is already deliberately non-coerced at :2107-2118, so the precedent
exists) — **claimed by #2566**. W5 undeclared 500 clears with W1.
**Unclaimed:** **W4** — every read/delete route can answer a 422 its own OpenAPI
never declares (GET `/{id}` declares only 200/404; DELETE only 204/404/409; the
failure hook answers 422 from `problem-details.ts:50-72`). **W9** — a wrong verb on
a *static* sub-path answers 422, not 405, because `DELETE /api/<agg>/by_email`
matches the sibling `delete /{id}` route and never reaches `app.notFound`, where
the only 405 probe lives (`typescript/emit/routes.ts:549-560`). **W6** — string
lengths are validated in UTF-16 code units (zod `.min()/.max()`) while the emitted
JSON Schema declares code points; `grep -rn codePoint src/` = zero hits. W8
(unknown query parameter accepted) is `by-design` — keep.

#### F29 — Java read-model entity-field backstop (unreachable by design)
`validateJavaReadModelShapes` (system-checks.ts:2213-2262) is a self-described
defensive backstop — a part type never resolves in workflow/projection scope, so
the gate is expected unreachable; it exists so the shape fails honestly instead of
crashing `guardInstanceField`/`guardProjectionField`. `M-T6.36` proposes folding
the target name out of the code identity per M-T5.21. No user impact.

#### F30 — Flutter `ProvenanceInfo` degrades to a comment (test-pinned decision)
`_walker/primitives/provenance-info.ts:47-62` has react/vue/svelte/angular arms and
a `renderComment` default; flutter supplies no override. Unlike F16 this **is**
pinned as a reviewed degradation (`provenance-info-cross-target.test.ts:220-233`
asserts the comment text *and* that no `provLineageSchema` is carried), and the
underlying value still renders — so it degrades rather than losing data.
`docs/new-plan/T1-ui-frontend.md:263` marks M-T1.19 `done`, true only for the five
ported frontends.

### §C — Prose that lost to the code (stale registers, comments, missions)

#### F31 — The corpus manifest still excludes dotnet from `policy-document`
**Status:** **stale** — drain.
`test/fixtures/corpus/manifest.ts:93` (`IN_APP_DOCUMENT_FILTER` = node/java/python
at :24) cites two defects, **both fixed**: `_CapabilityVisible` on the document repo
impl (`dotnet/emit/repository.ts:694`, applied :740/:804/:817) and
`GetByIdForWriteAsync` on it (:708). **Proved by build:** generated the fixture
(106 files) and ran `dotnet restore && dotnet build --no-restore /warnaserror` in
`mcr.microsoft.com/dotnet/sdk:10.0` → *Build succeeded. 0 Warning(s) 0 Error(s)*.
Widen the row to node/java/python/**dotnet**. (The elixir half of the same row is
live — F18.)

#### F32 — Three of four `BEHAVIOURAL_SKIP` entries are stale
`cases.mjs:307-319` skips `projection-aggregation`, `projection-groupby` and
`read-gates` on the Dapper leg claiming `loom.dapper-unsupported` "refuses to
generate". It does not: the blanket refusal was replaced by the narrow
`dapperQueryProjectionGap`, the raw-Npgsql arms are emitted
(`dotnet/query-projection-emit.ts:314-337,499-546,686-777`), and the dapper oracle
(`corpus-dotnet-dapper-build.test.ts:123-161`, 50 passed / 47 skipped) proves no
rejection. `read-gates` is the costliest: while it sits there the dapper leg
asserts **no runtime denial** for any of its three read-gate kinds. Deleting each
entry re-arms a real boot that has never run — pair the deletion with a
`node run-dapper.mjs <case>` run. Bonus: `projection-groupby` on dapper is exactly
the case F27's waiver is scoped to, so re-arming exercises it on a second adapter.

#### F33 — Four stale in-code references, one of them user-visible
(1) `system-checks.ts:1612` cites `loom.vanilla-containment-unsupported` as gating
document containments — **that code exists nowhere in `src/`** (no raise site, no
`messages.ts` entry) and :1785-1786 states containment mutation *is* admitted.
(2) :2185 refers to `loom.java-embedded-refcoll-unsupported` in the past tense with
no live raise site. (3) `util/platform-axes.ts:31` omits `document` for elixir while
:1571-1573 adds it back — the table reads as a per-platform truth source and is not
one (single consumer, so nothing else is misled). (4) **User-visible:** the elixir
document-filter diagnostic (:2445-2447) says filters are "only wired for relational
aggregates on the elixir backend" — **embedded is wired** (:2358) — and it advises
"Host this aggregate on a .NET deployable", the very backend the corpus manifest row
in F31 excludes. Fix the message in `src/diagnostics/messages.ts`.

#### F34 — Stale pack/walker comments
`_packs/required-primitives.ts` carries three false claims: (a) :126-129 says
`FileUpload` is exempt on HEEx because `KNOWN_HEEX_GAPS.FileUpload` pins it — no
such entry exists and FileUpload **has** a heex renderer (`registry.ts:406-412`);
(b) :46-51 still references `AshPhoenix.Form` — Ash was removed; (c) :236-246 says
vue/svelte/angular packs ship no chart so each is "an honest
`loom.chart-unsupported-target` gap" — `CHART_FRAMEWORKS` (system-checks.ts:416-424)
now names **every shipping framework** and an 11-cell sweep generated clean.
`registry.ts:334-335` and :659-661 claim `Section`/`CodeBlock`/`Icon` have no HEEx
renderer — all three do (:342, :666, :675).
`_walker/target.ts:39` still says the contract is "13 methods" — it is 72 (25
required + 47 optional). `renderStoreModule` (:1177-1183 plus a 34-line contract
block at :1125-1158) is implemented by **no** frontend — every target emits stores
from its own `store-builder.ts`; the seam is documented-but-dead.
`test/conformance/showcase-completeness.test.ts:234-243` says Chart "ships on react
+ mantine@v9 only" and `test/platform/feliz-pack-groundwork.test.ts:43-45` calls
Chart TSX-only on feliz — both false (`feliz/pack.ts:581-600`).
`docs/new-plan/T1-ui-frontend.md:267` still lists feliz as open for `auth: ui`;
`feliz/auth-gate.ts` has shipped.

#### F35 — Two ratchet justifications are stale, and ≥2 census codes are unreachable
`allowlist-ratchet.test.ts:51-55` says `ProjectionJoin`/`ProjectionSelect` are
"Gated (`loom.projection-query-time-unsupported`) until the per-backend query-time
emit lands" — that gate is **inert** (`PROJECTION_QT_SUPPORTED` = all five,
system-checks.ts:122, consumed :231); the showcase file's own comment already says
so. In `diagnostic-firing-census.data.ts` (38 `UNCOVERED` entries, pinned max 38),
at least two are **provably unreachable** rather than merely uncovered —
`loom.projection-query-time-unsupported` and `loom.saving-shape-unsupported` (every
shipping backend has all three shapes once the elixir `document` widening at
:1571-1573 is applied) — and belong in `UNREACHABLE_PINS`, which lowers the pin with
no implementation work. Siblings worth the same check:
`loom.audited-backend-unsupported`, `loom.event-sourcing-backend-unsupported`,
`loom.provenanced-backend-unsupported`, `loom.union-unsupported`,
`loom.when-unsupported` — all the same "N-backend-era" shape.

#### F36 — Two open missions rest on premises the code overturns
**`M-T6.34` ("Event-sourced storage exists on one backend of five")** — false on
this checkout: `EVENT_SOURCING_BACKENDS` (system-checks.ts:3704) and
`EVENT_SOURCING_WORKFLOW_BACKENDS` (:3744) are **both** full 5/5, the aggregate half
is pinned per-backend by `backend-parity-gates.test.ts:198-214` (marker
`accounts_events` on all five), and the workflow half has five emitters
(`hono/v4/workflow-eventsourced-builder.ts`, `dotnet/workflow-eventsourced-emit.ts`,
`python/workflow-eventsourced-emit.ts`, `java/emit/workflow-eventsourced.ts`,
`elixir/vanilla/workflow-eventsourced-emit.ts`). The mission also cites
`system-checks.ts:3263`/`:3302`, ~440 lines adrift.
**`M-T6.32` ("the four capabilities that gate honestly and emit nothing")** — all
four (`context-filter`, `filter-bypass`, `audited`, `provenanced`) are full 5/5
gate sets with named emitters per backend (§1). The mission's own first instruction
is "**First step is a re-verify**"; this audit is that re-verify and the answer is
that the platform axis is closed — the *adapter* axis (F1) and the elixir
`document` cell (F18) are what survive of it.
Both should be closed or rewritten to their true residue rather than implemented.

### §D — Coverage and governance

#### F37 — `backend-parity-gates.test.ts` pins 5 features of ~19, and never varies `shape:`
`DOMAIN_BACKENDS` (:41) × a `FEATURES` table (:158-238) of exactly five — capability
filter (relational non-principal), provenanced field, audited operation,
event-sourced aggregate, TPH — enforced as gated-XOR-emitted plus a two-way
cross-check against gate-set membership (:292-338). It does **not** cover paged
`queryHandler`, the four projection variants, projection-source projections, field
mask, audited **lifecycle** (its fixture exercises `operation … audited` only),
event-sourced **workflow**, generic carriers, unions, `when`, union returns, or
filter bypass. And because it never varies `shape:`, the capability-filter feature
is only probed on the relational non-principal cell — **precisely the cell where all
five agree**, leaving the one real hold-out (F18) outside the matrix.
**Highest-yield extension:** add `shape: document` + `shape: embedded` variants of
`filterDdd` and lift the six projection/paged sets into `FEATURES`.

#### F38 — Contract fuzzing runs on one backend of five
`run-schemathesis.mjs:119-127` hard-requires a single Hono deployable and bundles
with `platform: "node"` (:237); `package.json:85` defines only `test:schemathesis`;
`schemathesis.yml` is a single job with no matrix. Every W-rule in F28 is therefore
a **node-only observation** — the same defect class (coercion, undeclared 422/500,
verb-vs-`{id}` capture) is unmeasured on python/java/dotnet/elixir.

#### F39 — Two render paths have no full-stack runtime leg at any tier
**Flutter** is the only one of six frontends with no behavioural round-trip: the
harness structurally cannot host it (`run-ui.mjs:111-114` builds with
`npm install`/`npm run build`, which a Flutter SDK project has no analogue for), and
`frontend-fullstack-e2e.yml`'s matrix is vue/svelte/angular/feliz. Its only gates
are compile-only (`flutter analyze` + `flutter build web`) — which is exactly why
F13 survived. **HEEx** likewise has no behavioural leg (`run-ui.mjs` boots "built
SPA + Hono on PGlite", a topology LiveView does not have); its only runtime UI gate
is the post-merge `phoenix-ui-e2e`. vue/svelte/angular/feliz are nightly-only by
deliberate cost decision — all four cells are now `experimental: false`, so the
nightly is trustworthy; only its cadence is the gap.

#### F40 — The two render-degradation ratchets structurally cannot reach the drops they exist for
`render-degradation.test.ts` `KNOWN_DEGRADATIONS` (:92-106) and
`KNOWN_VERBATIM_INTRINSICS` (:117-130) are both **empty** and 23/23 pass across all
seven targets — but (a) its `SENTINELS` list (:74-84) has **no pattern** matching
the `not yet supported on <framework>` comment shape that `timeline.ts:55` and
`provenance-info.ts:59` emit, so F16/F30 are invisible to it; (b) the fixture's only
component is props-only (`component TierBadge(...)`,
`web/src/examples/expression-showcase.ddd:76`), so F15/F17 never reach the
`unknown layout component` sentinel that **is** in the list; and (c) the fixture
never places a sub-primitive at top level, so F11's
`not supported by the \w+ walker yet` sentinel — which *is* in the list — is
unreachable. `frontend-showcase-render.test.ts:46` covers five frontends and omits
**flutter and phoenixLiveView** entirely. Three silent findings in this audit were
each within one fixture line of an existing gate.

#### F41 — Two skip registers grow unwatched
`BEHAVIOURAL_SKIP` (cases.mjs:282) and `ELIXIR_COMPILE_SKIP` are the two registers
**not** in `allowlist-ratchet.test.ts`'s `REGISTERED` list (:43-197, 13 constructs) —
exactly the condition that forced `MIKRO_SKIP` to be registered ("had been growing
unwatched", :168-175). `BEHAVIOURAL_SKIP` currently holds 4 entries, **3 of them
stale** (F32), with no size ratchet and no per-key oracle like the dapper maps have.

#### F42 — Five Angular pack-render names are reachable but unpinned
Diffing every template name reachable through `renderPrimitive`/`ctx.pack.render`
(48 names) against `flattenRequired ∪ shared-sources` per format: tsx/vue/svelte are
fully covered; **angular** leaves `primitive-form-of`, `primitive-modal`,
`form-default-onsubmit` and the whole `field-input-*` family outside both — absent
from all three Angular pack manifests and the shared `angular/` dir. They are
unreachable *today* only because `angularTarget` forks every form primitive and
never returns null for a real `call` (:292-328). Any future Angular fork returning
null on a real `CreateForm`/`OperationForm`/`WorkflowForm`/`DestroyForm` reaches
`renderPrimitive("primitive-form-of")` (`forms.ts:473`) and **hard-throws at generate
time**. Nothing tests that. (`primitive-modal-controlled` is the only guarded
`pack.render` in the tree, `forms.ts:826`.)

#### F43 — `Chart` on vue/svelte/angular is design-pack-independent
No vue/svelte/angular `pack.json` declares `primitive-chart` (all 7 checked); it
comes from **one shared template per framework** (`vue/primitive-chart.hbs`,
`sveltekit/…`, `angular/…`) merged by `loader-fs.ts:36-50`, backed by generator-
emitted inline-SVG runtimes. So Chart renders on all three but looks identical
across their packs — unlike React, where all 8 packs bind their own charting
library. Not a gap; a documented asymmetry worth stating so nobody "fixes" it by
adding a required entry that would break every existing pack.

---

## 6. Open-missions appendix (generator-relevant, not done)

From a full sweep of `docs/new-plan/` (README + 10 track files +
`testing-quality-improvement-plan.md` + `coverage.md`) at this commit: **133 rows
harvested, 100 generator-relevant and not done** — ~50 `partial`, ~40 `open`, plus
`blocked`/`plan`/`concluded`/unmapped. T10 (7 missions) is excluded: all frozen
under the permanent 2026-07-17 target-matrix freeze. `testing-quality-improvement-plan.md`
owns M-T9.12–M-T9.20; T9 keeps 9.21+ (2026-07-29 renumber).

**⚠ Two live duplicate-ID collisions under `M-T6.41`** — line 108 (direct-table
aggregation drops `contextFilters`, F6) and line 590 (dapper unquoted identifiers,
F10). The line-108 entry's own note records it was minted as M-T6.40, renumbered
when #2551 took that, and then collided again. Third such incident this week; this
audit refers to them as `M-T6.41-contextfilters` and `M-T6.41-dapper-quoting`.

The missions this audit touches directly:

| Mission | Status | Remaining scope (this audit's view) | Finding |
|---|---|---|---|
| `M-T6.37` elixir seeder | open | Verified silent. Ecto seeder via the context `create` path + raw schema-qualified INSERTs + `__loom_seed` marker + boot invocation. Model: `java/emit/seed.ts:106`. | F8 |
| `M-T6.40` elixir list-page arity | open | Verified: `liveview-emit.ts:1070` vs the 0-arity `defdelegate`; three call sites. | F9 |
| `M-T6.41-dapper-quoting` | open | Verified: 7 unquoted `CREATE TABLE` sites, no quoting helper. | F10 |
| `M-T6.41-contextfilters` | open | Direct-table aggregation on drizzle + mikroorm. | F6 |
| `M-T6.38` `when` off-route | open | node/dotnet verified; java/python/elixir rows explicitly unverified. | F7 |
| `M-T5.20` denial ladder | partial | `NotFound` rung only; 4 backends; drift-prone (reverted once). | F26 |
| `M-T6.35` adapter capability gaps | open | Now precisely: F1, F4, dapper deep-scope, mikroorm deep-scope/abstract-parts/predicate subset. | F1,F4,F23,F24 |
| `M-T6.2` vanilla-Phoenix drain | partial | §12 document-shape residue, §14 four `serialize/1` snake_case leaks, §13 LiveView action residue. | F19 |
| `M-T6.30` Phoenix RFC 7807 floor | open | App-global error view + `application/problem+json` at the shell (`vanilla/shell-emit.ts`). | — |
| `M-T6.20` elixir precondition messages | partial | Path 2 (raise → prefix-routed `GUARD_RESCUE`) still emits derived text. | — |
| `M-T6.21` elixir unused `let` | open | Latent: unused workflow `let` warns, fatal under `--warnings-as-errors`. | — |
| `M-T6.39` `/files/{key}` 404 envelope | open | A fourth envelope shape, on zero backends. | — |
| `M-T6.12` provenanced wire pair | open | Fold value+lineage into one `Provenanced<T>` carrier in `wireShape`. | — |
| `M-T6.18` argument type-checking | partial | Gap #3: workflow create field types, UI prop passing, store action args. | — |
| `M-T1.18` flutter parity | partial | Phase-1 residue (4 marked drops **+ the unmarked `File` field, F12**) and Phase 3 (SSE, Dart method-call seam). | F12,F13 |
| `M-T1.20` frontend surface gaps | open | Five rejections: flutter `auth: ui`, feliz `match await`, flutter primitives, frontend collection ops, ui realtime. **feliz `auth: ui` is already shipped** — the row is stale. | F21,F34 |
| `M-T1.10` realtime beyond toast | partial | Elixir/LiveView + Flutter SSE legs; cross-tenant SSE isolation e2e. | F20 |
| `M-T2.7` seeding tail | partial | Phases 5–7 (workflow-body seed, `seed-spec.json` + compose step, `ddd seed` runner). | F8 (adjacent) |
| `M-T2.10` document/embedded completion | partial | `embedded` on Drizzle still emits relationally (verify-first); `document` on Ecto unscheduled behind the honest gate. | F18 |
| `M-T3.17` tenancy subtree index-usability | open | `strpos(data_key, anchor\|\|'.')=1` is correct but not sargable — deep reads seq-scan. | — |
| `M-T9.25` intra-backend consistency | partial | Round 2 items (4) nested `errors[]` pointer shape, (5) override-propagation asserted on node only. | F26 |
| `M-T9.27` unsupported register | partial | Slice 4: the full 419-code registry, docs anchors, fix hints. | F33 |
| `M-T6.32`, `M-T6.34` | open | **Premises overturned — close or rewrite, do not implement.** | F36 |

Five archived-corpus items are dispositioned open-and-unpicked in `coverage.md`,
four of them generator work: `connection-secret-wiring` (:28,:267), **API
versioning** (:234,:268 — no proposal exists at all), `infrastructure-port`
(:67,:269, parked), `bounded-context-model` deferred futures (:25), and the
customization cliff (:233,:271). Two register rows are **unowned**:
`loom.workflow-load-array-unsupported` and `loom.workflow-load-nullable-unsupported`
(`workflow-checks.ts:591,600`) carry no `mission` field, though `M-T4.7`'s body
describes the same gap.

**Denominator caution.** ~60 of the 100 rows are `partial` with their remainder
stated only in a mid-paragraph "Remaining:" clause, and several carry explicit
⚠ verify-first flags (M-T5.10, M-T2.10, M-T9.26, M-T6.14). Only ~8 were
independently confirmed against emitters during this sweep (listed above); F36
shows what happens when they are not. Also unreconciled: `coverage.md:240` still
lists 13 LIVE rows from `fleet-bug-hunt-2026-07-19` while
`T9-toolchain-health.md:105` marks M-T9.24 `done` with "all 26 items closed" — the
two roadmap docs disagree and neither was re-verified here.

---

## 7. Method notes

Six audit agents ran in parallel against the same checkout; every claim they
returned carries a `file:line` citation, and the load-bearing ones were proved by
running the toolchain rather than by reading it.

| Agent | Read | Proof technique used |
|---|---|---|
| **gates** | all 24 cross-backend gate sets (`system-checks.ts`, `structural-checks.ts`, `platform-axes.ts`, `test-placement.ts`, `ir/util/channels.ts`, the `validate.ts` wiring) + one named emitter per backend per row | rebuilt `out/` (`npx tsc -b`) and ran `ddd parse` on scratch fixtures to prove the elixir `document`-filter gate fires and that `shape: document` itself does **not** |
| **adapters** | `validateDapperSupport`, `validateMikroOrmSupport`, `find-predicate-capability.ts`, both adapter emitters end-to-end, plus timers / channels / resources / projections / shapes / extern / criterion / domainService across five backends | grep-completeness over the emitters (e.g. 0 hits for `writeScopeFilter` in 3033 lines of `mikroorm.ts`), call-site guard tracing for the crash path |
| **feCore** | `walker-primitive-names.ts`, `_walker/registry.ts`, `_walker/target.ts`, `required-primitives.ts`, all four JSX targets, all 15 JSX pack manifests | ran `parse` + `lowerModel→enrichLoomModel→validateLoomModel` on misplaced sub-primitives (F11); out-of-repo sweep of 4 frameworks × 15 pack versions × 3 showcase UIs = 45 cells, plus 22 Chart/DataGrid cells |
| **feAlt** | `feliz/` and `flutter/` in full (packs, targets, forms, stores, components, i18n, expression leaves), plus i18n emission on all six frontends + HEEx | script-diffed each procedural `RENDERERS` table against its required set; generated real projects and **read the emitted `App.fs` / `.dart`** for F12/F13/F15 |
| **ratchets** | every skip/waiver/allowlist register (24 of them, 88 entries) | ran `corpus-dotnet-dapper-build.test.ts` (50 passed), `override-status-census`, `authz-status-census`, `heex-parity`, `render-degradation`, `frontend-showcase-render`; generated + `dotnet build /warnaserror` in `mcr.microsoft.com/dotnet/sdk:10.0` to disprove F31 |
| **roadmap** | `docs/new-plan/` README + 10 tracks + `testing-quality-improvement-plan.md` + `coverage.md` | cross-walked every gate-shaped mission against `src/diagnostics/unsupported-register.ts` (402 lines, 37 `gap` + 8 `scope` rows) and spot-verified ~8 against emitters |

**What was not done.** No fix was implemented and no gate was changed by this
audit. F25 verified only the *absence* of a gate, not the other emitters' output.
F7's java/python/elixir rows are unverified. The `coverage.md` ↔ `T9` disagreement
above is unreconciled. Per the repo's own rule, treat every uncited status claim
in `docs/new-plan/` as a hypothesis until it is re-read against `main`.

**Companion artifact.** The unclaimed findings here are drained into a
wave-structured fleet plan (wave 1 correctness → wave 2 honest-gap ports → wave 3
breadth), with gaps already covered by open PRs #2568, #2569, #2566, #2541, #2590,
#2587/#2574, #2583, #2581, #2575 excluded as claimed.
