# Cross-target completeness audit — 2026-08-30

**Snapshot commit:** `origin/main` @ `38580cd77`. Produced by two 8-agent fleets (a ledger re-verification fleet and an empirical generation fleet: 16 Opus agents, ~4M tokens, 2100+ tool calls) plus a merge synthesis. Companion machine-readable ledger: `targets-completeness-2026-08-30.ledger.json`; implementation wave plan: `targets-completeness-2026-08-30.waves.json`. Supersedes the ledger portions of `targets-completeness-2026-08-17.md` (whose plan is now fully dispositioned).

# Loom canonical gap ledger — fleet-1 + fleet-2 merge

Base: `main` @ 38580cd77 · built 2026-08-30 · claim map applied (PR #2667 = audit + all 21 A-findings fixed; numeric fleet #2670–#2678; #2646; #2664/#2648/#2660/#2669 merged).

## Counts

| metric | value |
|---|---|
| open rows | **158** |
| P0 | 0 |
| P1 | 9 |
| P2 | 15 |
| P3 | 32 |
| P4 | 90 |
| P5 | 12 |
| kind: silent / honest / breadth / mission / stale-prose | 24 / 32 / 26 / 64 / 12 |
| confidence: proven / likely / suspected | 30 / 126 / 2 |
| class: faulty-fix / regression | 1 / 0 |
| size S / M / L | 43 / 68 / 47 |
| provenance: fleet1-only / fleet2-only / corroborated by both | 141 / 16 / 1 |
| claimed by an open PR | 61 |
| done / merged | 134 |
| conflicts | 10 |
| checkedOk entries | 146 |
| rows scheduled into waves | 134 across 13 packets |

## Open ledger

Sorted P0 (security / data-integrity, silent, proven) → P1 (other silent proven) → P2 (silent likely/suspected) → P3 (honest) → P4 (breadth/mission) → P5 (stale-prose).

`!` marks a **security / data-integrity class** row. P0 requires that class *and* `proven`; a security-class row that is only `likely` (fleet-1 rows default to `likely` unless their own evidence says VERIFIED/reproduced) stays at P2 with the `!` so it is not lost in the tail — 6 such rows exist and are the highest-value re-verification targets.

| P | id | kind/class | conf | targets | size | title |
|---|---|---|---|---|---|---|
| P1 | `F2-CB-C7-domainservice-in-requires-guard` | silent | prov | node, dotnet, java, python | S | A `domainService` call inside a `requires` authorization guard passes validation and emits an unresolvable reference on four of five backends |
| P1 | `F2-CFE-9` | silent | prov | flutter | S | Flutter's `Money` / `DateDisplay` / `EnumBadge` primitives do not null-guard an OPTIONAL field — two produce Dart that fails static analysis, the third renders the literal text "null" |
| P1 | `F2-MT640-SORT-DEAD` | silent | prov | elixir | S | M-T6.40 shipped as option (a) — the non-paged elixir list page now compiles, but its sortable headers are a no-op refetch (and the mission row still reads `open`) |
| P1 | `F2-CB-C1-paged-nonrelational` | silent | prov | node, dotnet, python, elixir | M | `find … paged` on a non-relational aggregate (eventLog / document / embedded) emits a route built for the paged contract against a repository built for the unpaged one |
| P1 | `F2-CFE-1` | silent | prov | react, vue, svelte, angular, feliz, flutter, heex | M | `navigate(<Page>)` in a page `action` body — the only documented home for navigation — is broken on all 7 frontend targets (feliz hard-crashes codegen) |
| P1 | `F2-XB-4` | silent | prov | node, dotnet, java, python, elixir | M | Every non-assignment statement in a folded-projection `on(e)` body is silently dropped on all five backends — and a `let` its own assignment references emits an undefined identifier |
| P1 | `G2644-M-T6.48-numeric-ingress` | silent | prov | dotnet, java, python, elixir | M | #2644 F12 / M-T6.48 — malformed numeric input answers 500, not 4xx, on four backends |
| P1 | `flutter-form-field-drops` | silent | prov | flutter | M | Four Flutter form-field drops are still emitted as Dart COMMENTS, not diagnostics — the parity freeze is unchanged since the 08-17 snapshot |
| P1 | `flutter-modal-instance-operationform` | silent | prov | flutter | M | Flutter drops the ENTIRE operations row of every scaffolded Detail page — `renderModal` only matches `OperationForm { of:, op: }` |
| P2 ! | `G2646-open-projection-on-event-no-channel` | silent | like | dotnet, java, python, elixir | M | #2646 documented, NOT fixed: `projection … on(Event)` with no `channel` folds on node only; the other four silently never subscribe |
| P2 ! | `M-T3.15-C3-nav-vs-requires` | silent | like | react, vue, svelte | M | C3 — the default sidebar shows links to routes the backend refuses (react/vue/svelte) |
| P2 ! | `M-T3.8-sensitivity-phases-2-4` | silent | like | node, dotnet, java, python, elixir | L | `sensitive(...)` reaches exactly one emitter — no wire masking, no sink classification, and no diagnostic saying so |
| P2 ! | `dapper-no-schema-evolution` | silent | like | dotnet | L | `persistence: dapper` has no ALTER path at all — every post-first-boot model change is silently unapplied (migrations-on-adapters slice 2) |
| P2 | `F2-FFE-8` | silent | susp | feliz, flutter | S | Flutter and Feliz persisted stores write a FLAT JSON blob under the same `loom.store.<Name>` key the JS frontends use for zustand's `{state,version}` envelope |
| P2 | `F2-W-06` | silent | like | elixir | S | elixir persists `datetime` at SECOND precision (`:utc_datetime`) where the other four use TIMESTAMPTZ(µs) |
| P2 | `M-T6.2-s14-audit-wiresnapshot` | silent | like | elixir | S | Elixir audit before/after snapshots still dump the raw snake_case Ecto struct while the other four record the wireShape |
| P2 | `G2646-open-heex-layout-inert` | silent | like | elixir | M | #2646 documented, NOT fixed: HEEx layout primitives semantically inert (Grid ≡ Stack, bare divs); non-server-paged Table gets no pager; i18nFormat wrapper dropped |
| P2 | `M-T1.16-invariant-validation-feliz-flutter` | silent | like | feliz, flutter | M | Invariant-derived client-side form validation is missing on BOTH self-hosting frontends — Feliz and Flutter enforce "Required" only |
| P2 | `M-T5.14-reading-service-readport-not-threaded` | silent | like | node, python, dotnet, java, elixir | M | A `reading` domain service called from a command/query handler emits a port-less call — the generated module does not compile |
| P2 | `queryview-lambda-int-plus-literal-concat` | silent | like | react, vue, svelte, angular | M | An int LITERAL operand of `+` against a read-record member in a page body lowers to string concatenation — `o.qty + 1` renders `o.qty + String(1)` |
| P2 | `schemathesis-F11-int32-range` | silent | like | node, dotnet, java, python, elixir | M | F11/W11+W12 — an `int` body field publishes no bound while the column is Postgres `int4`, so a contract-conforming value 500s; explicitly deferred by both open schemathesis PRs |
| P2 | `sourcemap-feliz-flutter-not-emitted` | silent | like | feliz, flutter | M | `--sourcemap` records NOTHING for the feliz and flutter frontends — the plan files it as a test-parity skew, but the emission is absent |
| P2 | `static-subpath-405-node-only` | silent | like | dotnet, java, python, elixir | M | The F8 static-sub-path 405 guard landed on the Hono emitter alone — a wrong verb on a static sub-path still answers the sibling `/{id}` route's 422 on dotnet / java / python / elixir |
| P2 | `M-T1.11-domain-floor-message-code` | silent | like | node, dotnet, java, python, elixir | L | M-T1.11 item (c) — `DomainError` carries no `code` on any of the five backends, so a rule enforced only at the domain floor is unlocalizable |
| P3 | `F2-CFE-11` | honest | prov | angular, flutter | S | `testid:` on `CreateForm` is silently dropped on Angular and Flutter (honoured on react/vue/svelte/feliz) |
| P3 | `F2-W-09` | honest | prov | node, elixir, dotnet, java, python | S | A `File` field is an inline anonymous object on node/elixir and a named `FileRef` component on dotnet/java/python |
| P3 | `F2-W-12` | honest | like | java, elixir | S | Optional-field nullability: java and elixir publish a non-nullable schema for fields they serialize as `null` |
| P3 | `M-T3.15-E2-getbyid-no-gate-surface` | honest | like | language, validator | S | E2 — the by-id read has no author gate surface at all |
| P3 | `M-T5.19-a-workflow-test-anchor` | honest | like | language, node, dotnet, java, python, elixir | S | `WorkflowMember` still has no `TestBlock` arm |
| P3 | `M-T5.5-stdlib-tail` | honest | like | language, node, dotnet, java, python, elixir | S | Stdlib tail — block-form top-level functions honestly refused; storable `duration` and the `std/*.ddd` prelude unbuilt |
| P3 | `F2-CFE-10` | honest | prov | react, vue, svelte, angular, feliz, flutter, heex | M | String literals inside a `match` in a user-visible slot are silently untranslatable, while string `+` in the SAME slot is a hard validator error — `ddd i18n check --strict` passes on a page shipping hardcoded English |
| P3 | `F2-EXPR-7` | honest | like | node, elixir, java, dotnet, python | M | `.first` on an empty collection has no cross-backend contract — 3 backends throw, node and elixir return an undefined/nil typed as non-optional |
| P3 | `F2-W-08` | honest | prov | dotnet, java, node, python, elixir | M | A `valueobject` aggregate field publishes ONE shared component on node/python/elixir and TWO (`<VO>Request` + `<VO>Response`) on dotnet/java |
| P3 | `F2-W-14` | honest | susp | dotnet | M | dotnet likely publishes an EMPTY schema for a union-returning operation's 200 body (no `UseOneOfForPolymorphism`) |
| P3 | `G2646-open-node-mounts-ui-false` | honest | like | node | M | #2646 documented, NOT fixed: node is the only backend with mountsUi: false |
| P3 | `M-T1.10-handler-vocabulary` | honest | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | M | M-T1.10 — `on <channel>.<Event>` handler bodies remain a closed two-verb vocabulary (`toast` + `refetch`) |
| P3 | `M-T1.20-feliz-match-await` | honest | like | feliz | M | M-T1.20 — `loom.feliz-async-effect-unsupported` residue is narrower than documented: only a route-id-less host and a non-aggregate-instance subject stay gated |
| P3 | `M-T3.7-e-claim-typed-capability-fields` | honest | like | macros, enrich, validator | M | `tenantOwned` still hardcodes `tenantId: string`, so a `guid` claim is refused |
| P3 | `M-T5.3-nested-carriers-and-option` | honest | like | language, node, dotnet, java, python, elixir, react | M | Nested carriers stay gated; `option` lowers but the three-state PATCH it unblocks is unbuilt |
| P3 | `M-T5.7-inheritance-tail` | honest | like | dotnet, node, java, python, elixir | M | Inheritance tail — all three remaining items are honest register rows |
| P3 | `M-T6.2-s12-vanilla-document-gate` | honest | like | elixir | M | §12 residue: the Elixir document-shape gate still honestly rejects named ops and non-scalar-predicate finds |
| P3 | `feliz-flutter-persist-codec-asymmetry` | honest | like | feliz, flutter | M | The new field-scoped `loom.store-lifetime-target-unsupported` splits feliz and flutter into two DIFFERENT covered type sets — a `persist:` store portable between them does not exist |
| P3 | `workflow-projection-rename-unexpressible` | honest | prov | node, dotnet, elixir, python, java | M | M-T2.1 slice (d) — renaming a `workflow` or `projection` drop+recreates its state/projection table; `TableRename` cannot name one |
| P3 | `M-T1.3-keyed-folded-projection-reads` | honest | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | L | M-T1.3 — KEYED and FOLDED projection reads are unreadable from any frontend (honest gate, unclaimed) |
| P3 | `M-T3.15-B1-projection-masking` | honest | like | node, dotnet, java, python, elixir | L | B1 — gated projections and `mask unless` are still mutually exclusive by validator |
| P3 | `M-T5.4-criterion-tails` | honest | like | language, node, dotnet, java, python, elixir | L | Criterion/retrieval tails — `from <Criterion>(args)` on params and explicit `loads:` are honestly gated; `Repo.find(<Criterion>)` already shipped |
| P3 | `M-T5.8-lifecycle-operations` | honest | prov | dotnet, elixir, java, language, node, python | L | Lifecycle-operations phases 3–5 — named lifecycle actions are now REFUSED rather than silently dropped, but still not emitted as routes |
| P3 | `M-T6.35` | honest | prov | dotnet, node, elixir | L | Persistence-adapter capability gaps — five honest gates still live |
| P3 | `columnless-directtable-projection-emitters` | honest | like | node, dotnet, java, python, elixir | L | Direct-table query-time projections still cannot read event-log / document-jsonb / TPC-base storage on ANY backend — the universal gate is the whole answer |
| P3 | `dapper-tenancy-hierarchy-unsupported` | honest | like | dotnet | L | `tenancy-hierarchy` is the sole surviving `DAPPER_UNSUPPORTED` entry — hierarchical tenancy's capability filter is outside the Dapper SQL subset |
| P3 | `heex-datagrid-gap` | honest | like | flutter, phoenixLiveView | L | `DataGrid` is still the one TSX-rendered primitive with no HEEx renderer |
| P3 | `job-construct-unbuilt` | honest | like | node, dotnet, elixir, python, java | L | M-T4.6 — the `job` construct and templated/HTML email (4.6-email-c) are designed but unbuilt |
| P3 | `m-t4-8-contract-typed-resources` | honest | like | node, dotnet, elixir, python, java | L | M-T4.8 residual — the `contract` typed-resource declaration (inbound `from openapi(...)` clients) is unbuilt; `need ⊆ sourceType` activation is substantially shipped |
| P3 | `m-t4-9-read-cache` | honest | like | node, dotnet, elixir, python, java | L | M-T4.9 read caching tier — entirely unstarted; `cached(ttl)` has no surface, and the `ttl`/`keyPrefix` knobs that would gate it are inert no-ops |
| P3 | `seed-tail-phases-5-7` | honest | like | cli, node, dotnet, elixir, python, java | L | M-T2.7 seeding tail — imperative workflow-body seed, `seed-spec.json` + compose seed step, and the `ddd seed` runner (+`--reset`, `key:` upsert) are all unbuilt |
| P3 | `snapshot-policy-knobs-inert` | honest | prov | node, dotnet, elixir, python, java | L | M-T4.7 snapshots — `every:` / `retain:` on an `eventLog`/`snapshot` resource are read by zero emitters (warned, but the warning never reaches a CLI user) |
| P4 | `G2644-M-T5.24-avg-over-money` | mission | like | node, dotnet, java, python, elixir | S | #2644 F14 / M-T5.24 — projection `avg` over money is typed decimal (lossy double) while the in-memory avg of the same field is money |
| P4 | `G2644-M-T9.37-comparator-fidelity` | breadth | like | test harness | S | #2644 F16 / M-T9.37 — the wire-golden comparator JSON-parses bodies, so EXCESS numeric precision can never fail the gate |
| P4 | `G2667-B3-duplicate-golden-coverage-gates` | breadth | like | test harness | S | Two parallel gates assemble the same golden-coverage invariant independently |
| P4 | `G2667-C9-packaging-tests-worktrees` | breadth | like | test harness | S | 08-17 register #9: packaging-split tests fail inside git worktrees |
| P4 | `G2667-D13-generate-helper-residue` | breadth | like | test harness | S | Debt: system-layer residue for #2647's direct-caller ratchet |
| P4 | `G2667-F6-fix-scope-rule` | mission | like | docs | S | Process: a fix touching a mode/shape/adapter split must state which OTHER cells of that axis it re-verified |
| P4 | `M-T1.11-untranslatable-emitter-sentences` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | S | M-T1.11 — two emitter-built sentence frames remain untranslatable: the Chart accessible name and the ProvenanceInfo disclosure summary |
| P4 | `M-T3.1-language-default-flip` | mission | like | language, validator | S | `enforcement:` still defaults to `opt` — the deny-by-default language flip is the only piece left |
| P4 | `M-T3.11-execution-context-build-flags` | mission | like | language, node, dotnet, java, python, elixir | S | No user-facing `emitContextBoundaries`/`emitProvenance`/`emitTracing` build-flag surface |
| P4 | `M-T3.15-E1-handler-header-gate` | mission | like | language, node, dotnet, java, python, elixir | S | E1 — `commandHandler`/`queryHandler` still have no header `requires` (the default-deny half landed) |
| P4 | `M-T3.16-C2-elixir-403-vs-422` | breadth | prov | elixir, node, dotnet, java, python | S | C2 — a guarded create with an invalid body answers 403 on Elixir vs 422 elsewhere, ungoldened |
| P4 | `M-T3.16-C4-forbidden-remap-golden` | breadth | like | node, dotnet, java, python, elixir | S | C4 — no golden covers a remapped `Forbidden` on the lifecycle rungs |
| P4 | `M-T3.9-logged-marker` | mission | like | language, node, dotnet, java, python, elixir | S | The `logged` marker never shipped |
| P4 | `M-T6.11` | mission | like | node, dotnet, java, python, elixir | S | Reserved compose slots — three optional `ComposeServiceShape` data slots, undefined on every backend |
| P4 | `M-T6.14` | mission | like | dotnet, elixir, node | S | Small parity leftovers — the register is partly stale; one of its four items is verifiably drained |
| P4 | `M-T7.8-multi-framework-per-host` | mission | like | react, vue, svelte, angular | S | `hostableFrameworks` exists but a ui still binds ONE host deployable (T7 — light pass) |
| P4 | `M-T8.4-lsp-fold-to-macro` | mission | like | lsp | S | No `Fold to macro` inverse code action (T8 — light pass) |
| P4 | `m-t2-9-datasource-bindings-done` | mission | like | node, dotnet, elixir, python, java | S | M-T2.9 — `dataSources:` bindings and the capability matrix both ship (relocated, not missing); only per-deployable outbox overrides remain |
| P4 | `style-adapter-dead-emit-methods` | breadth | like | node, dotnet, java, elixir | S | M-T9.2's dead-`emit*` class recurs one adapter over: `StyleAdapter.emitEndpoint/emitHandlerOrService/emitDi` reach the emit path zero times |
| P4 | `G2644-M-T5.23-long-contract` | mission | like | node, python, java, dotnet | M | #2644 F13 / M-T5.23 — `long` has no contract: JS-number storage and float() aggregates corrupt past 2^53; int-overflow is 3-way divergent |
| P4 | `G2644-M-T9.38-frontend-runtime-legs` | breadth | prov | feliz, flutter | M | #2644 F17 / M-T9.38 — Flutter and Feliz have no runtime leg (flutter half now landed; feliz still bare, neither leg is numeric-rich) |
| P4 | `G2667-C-looseends` | breadth | like | react, vue, svelte, angular, test harness, ci | M | 08-17 loose ends still open: Card variant/shadow honoured by 3 of 15 packs (C9); branch-protection up-to-date rule (B4/M-T9.7); no emitter ever produces a node@v4 project (C10 CI half); API versioning golden count rising (D5); runtime-gate parity manifest (E7) |
| P4 | `G2667-C10-stmttarget-normalizations` | breadth | like | node, dotnet, java, python, elixir | M | 08-17 register #10: StmtTarget's three preserved inconsistencies stay un-normalized |
| P4 | `G2667-D5-handler-atomicity-asymmetry` | mission | like | java, dotnet, node | M | Debt: handler atomicity asymmetry — java handlers are class-@Transactional, .NET/node commit per SaveAsync |
| P4 | `G2667-F3-one-ref-walker-per-ir-family` | mission | like | elixir, python, java, dotnet | M | Architecture: one ref-walker per IR family, never hand-enumerated switches (root cause of A16 ×3 and A17) |
| P4 | `G2667-F4-realtime-plan-contract` | mission | like | node, dotnet, java, python, elixir | M | Architecture: give realtime a plan-level contract (streams inherit deployable auth; durable events tee at write-time) |
| P4 | `M-T1.10-phoenix-sse-no-rooms` | mission | like | elixir | M | M-T1.10 — the Phoenix SSE relay implements no tenant ROOMS: every tenant-scoped event degrades to a broadcast refetch ticket |
| P4 | `M-T1.12-axe-heex-cell` | breadth | like | phoenixLiveView | M | M-T1.12 — the axe matrix has no HEEx cell; the two Phoenix packs are the only shipping frontend surface with no automated a11y scan |
| P4 | `M-T1.17-builder-polish` | mission | like | playground | M | M-T1.17 — builder auto-layout (dagre/elk), nested grouping, add-target picker, drag-rebind: none shipped |
| P4 | `M-T1.2-file-delete-orphan` | mission | prov | node, dotnet, java, python, elixir | M | M-T1.2 — deleting a row leaves its `File` object orphaned in the object store on all five backends |
| P4 | `M-T1.3-scaffold-chart-tile` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | M | M-T1.3 Phase 5 — `scaffoldDashboard` emits an `<Agg>PerDay` series projection that NO scaffolded page reads; the Chart tile's stated blocker is gone |
| P4 | `M-T3.10-can-op-authz-aware` | mission | like | node, dotnet, java, python, elixir, react, vue, svelte, angular | M | `can_<op>` is a bare `{allowed}` probe for `when`-gated ops only — no authz slice, no reason, no pendingValidation |
| P4 | `M-T3.14-sast-over-generated-auth` | breadth | prov | ci | M | No security scanning over generated auth/tenancy code |
| P4 | `M-T3.15-A3-provenance-read-endpoint` | mission | prov | node, dotnet, elixir | M | A3 — `provenance_records` is still a write-only substrate with no read endpoint |
| P4 | `M-T3.15-C1-scaffold-binds-all` | mission | like | macros, react, vue, svelte, angular, feliz, flutter | M | C1 — the scaffold's List page still binds `.all`, not a projection |
| P4 | `M-T3.15-D3-D4-find-route-teardown` | mission | like | language, node, dotnet, java, python, elixir | M | D3/D4 — a named `find` is still a public GET route, and `requires` still lives on `FindDecl` |
| P4 | `M-T3.2-item5-exists-quantifier` | mission | like | language, node, dotnet, java, python, elixir | M | `exists <Aggregate>` quantifier not started |
| P4 | `M-T3.6-2b-deepscope-sentinel` | mission | like | node, dotnet, java, python, elixir | M | `__loomDeepScope__`/`scope` sentinel retirement still blocked — the queryable subset has no string `+` and the NULL-dataKey fallback is load-bearing |
| P4 | `M-T3.6-6-crosstenant-fail-closed` | mission | like | validator, enrich | M | `crossTenant` has no explicit-acknowledgment surface, and the ladder rejects the proposal's own example |
| P4 | `M-T5.1-A5-A6` | mission | like | language, node, dotnet, java, python, elixir | M | A5 (parse/external-api results as `or`) and A6 (`validate for X`) have no surface |
| P4 | `M-T5.10-wireshape-retirement` | mission | like | node, dotnet, java, python, elixir, feliz | M | The `wireShape` retirement is much further along than the mission text says — 32 property reads left, mostly projection-scoped |
| P4 | `M-T5.12-typed-capabilities-tail` | mission | like | lsp, node, dotnet, java, python, elixir | M | Typed-capabilities tail — go-to-capability + completion SHIPPED; find-implementors and `I<Capability>` marker emission open |
| P4 | `M-T5.13-multi-file-stage-b` | mission | like | language, validator | M | Stage B cross-context `X id` identity refs — no `uses`/`export` surface |
| P4 | `M-T5.14-shape-b-coordinator` | mission | like | language, node, dotnet, java, python, elixir | M | Domain-services Shape B (the coordinator) unbuilt |
| P4 | `M-T5.16-compiler-fragility-guards` | breadth | like | language | M | The type-system's parallel walkers have no exhaustiveness gate, and the `unknown` cascade has no lint |
| P4 | `M-T5.2-failure-sink-contract` | mission | like | language, node, dotnet, java, python, elixir | M | `errors {}` policy override and `expose`/public-contract error translation do not parse |
| P4 | `M-T6.13` | mission | like | node, dotnet, java, python, elixir | M | OpenAPI `x-tagGroups` doc-level grouping ships on zero backends |
| P4 | `M-T6.2` | mission | like | elixir | M | M-T6.2 vanilla-Phoenix gap register drain — still `partial`, but two of its three named residues moved |
| P4 | `M-T8.2-sourcemap-fanout` | breadth | like | dotnet, java, python, elixir | M | `renderExprWithMarks` reaches only the TS backend (T8 — light pass) |
| P4 | `M-T9.13-e2e-less-register` | breadth | like | node, dotnet, java, python, elixir | M | M-T9.13: `E2E_LESS_CORPUS_FIXTURES` has GROWN to 13 (the plan says 9) — features compiling on five backends and running nowhere |
| P4 | `M-T9.22-generative-fuzzing` | breadth | like | pipeline, all five backends | M | M-T9.22: no generative `.ddd` fuzzer exists — the corpus proves the pipeline on a fixture LIST, never on the valid-input SPACE |
| P4 | `M-T9.23-size-boot-budgets` | breadth | like | all frontends, all five backends | M | M-T9.23: no size or boot-time budget gate exists on generated output |
| P4 | `M-T9.27-slice4-full-code-registry` | breadth | like | diagnostics, toolchain | M | M-T9.27 slice 4 — the full diagnostic registry (all ~496 codes, kind + docs anchor + fix hints) is unbuilt and unclaimed |
| P4 | `M-T9.33-firing-census-drain` | breadth | like | node, dotnet, java, python, elixir, frontends | M | M-T9.33 drain: 31 catalogued diagnostics still have no firing proof — chiefly the per-backend `*-unsupported` rejections M-T9.27's honest-gap guarantee rests on |
| P4 | `M-T9.4-workflowir-facade` | mission | like | node, dotnet, java, python, elixir, react | M | M-T9.4 residue A5: the deprecated `WorkflowIR` primary-create facade is still the field every backend workflow emitter reads |
| P4 | `eventsourced-document-status-census` | breadth | like | node, python, dotnet, java, elixir | M | M-T9.25 round-2 probe 3: ES/document repository builders' own Concurrency/404 sites are reached by no census fixture |
| P4 | `m-t4-10-backend-to-backend` | mission | like | node, dotnet, elixir, python, java | M | M-T4.10 backend-to-backend calls — the typed-invocation half shipped under M-T4.8; only peer authn / cross-stack peers remain, and no proposal owns them |
| P4 | `override-parity-non-node-routers` | breadth | like | node, dotnet, java, python, elixir | M | M-T9.25 round-2 probe 5: 'one override moves EVERY router' is asserted per-file on node only; the workflow/extern/projection routers are uncensused on all five |
| P4 | `timers-e2e-leg-missing` | breadth | like | node, dotnet, elixir, python, java | M | No standing runtime gate for timers — every fire / single-fire / catch-up proof to date is a per-PR hand-run (M-T4.1) |
| P4 | `G2644-M-T5.22-decimal-arithmetic-rule` | mission | prov | node, dotnet, java, python, elixir | L | #2644 F11 / M-T5.22 — decimal arithmetic has no governing rule: 0.1+0.2 diverges on the wire AND in storage across backends |
| P4 | `G2644-M-T9.36-wire-codec-seam` | mission | like | node, dotnet, java, python, elixir | L | #2644 root cause / M-T9.36 — the numeric wire-codec seam: one per-backend codec contract + a boundary-enumeration completeness gate |
| P4 | `G2646-open-python-no-realization-axes` | mission | like | python | L | #2646 documented, NOT fixed: python has no realization axes (no directoryLayout: menu, no second persistence adapter) |
| P4 | `G2667-C5-outbox-insert-outside-tx` | mission | like | node, dotnet | L | 08-17 register #5: workflow/extern/timer outbox inserts sit outside any transaction (node AND .NET) |
| P4 | `M-T1.10-realtime-no-runtime-e2e` | breadth | prov | node, dotnet, java, python, elixir | L | M-T1.10 — the realtime SSE wire (incl. the security-relevant tenant-room routing) has NO runtime e2e on any backend; no cross-tenant isolation test exists |
| P4 | `M-T1.13-menu-reform` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | L | M-T1.13 — implicit sidebar derivation, the per-page `menu {}` bag, and the overloaded `menu` keyword all still ship |
| P4 | `M-T1.18-ios-and-ondevice` | breadth | like | flutter | L | M-T1.18 Phase 4 — no iOS build and no on-device `integration_test` leg (no macOS host) |
| P4 | `M-T1.2-s3-presigned-upload` | mission | prov | node, dotnet, java, python, elixir | L | M-T1.2 slice 3 — `s3` presigned direct-to-bucket upload for `File` is unimplemented on all five backends |
| P4 | `M-T1.6-forms-tail` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | L | M-T1.6 forms tail — WizardForm, async refines, optimistic updates, option "leave unchanged", flat-key schema: no code for any of them |
| P4 | `M-T1.7-async-actions` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | L | M-T1.7 — `attempt {}` / `onError` / `spawn` / `async` do not exist in the grammar at all |
| P4 | `M-T1.8-errors-block-and-await-terminus` | mission | like | react, vue, svelte, angular, feliz, flutter, phoenixLiveView | L | M-T1.8 — no `errors {}` declarative override and no unhandled-`await` terminus on any frontend |
| P4 | `M-T3.12-identity-batteries` | mission | like | macros, node, dotnet, java, python, elixir | L | Signup / invite / role-assignment batteries — proposal-stage, no code |
| P4 | `M-T3.15-A1-system-read-construct` | mission | like | language, node, dotnet, java, python, elixir | L | A1 — no first-class system-read construct; the compiler-owned reads still each have their own answer |
| P4 | `M-T3.6-35-organization-context` | mission | like | language, node, dotnet, java, python, elixir | L | `organizationContext` accessor + its switch gate — nothing exists |
| P4 | `M-T5.1-A4-getbyid-or-notfound` | mission | like | node, dotnet, java, python, elixir | L | A4 — `Repo.getById` still throws instead of returning `X or NotFound` |
| P4 | `M-T5.19-b-test-authoring-language` | mission | like | language, node, dotnet, java, python, elixir | L | The test-authoring language is entirely unbuilt |
| P4 | `M-T5.21-callable-unification` | mission | prov | language, node, dotnet, java, python, elixir, react, vue, svelte, angular, feliz, flutter | L | Fifteen callable productions, and the duplicated diagnostics they force, are all still there |
| P4 | `M-T5.4-d-phoenix-criteria-reification` | mission | like | elixir, node, dotnet, java, python | L | Phoenix has no criteria reification — criteria are inlined, and `usesUser` threading survives everywhere |
| P4 | `M-T6.3` | breadth | like | elixir | L | Phoenix output hygiene: `mix format` + Dialyzer gates still deferred after slice 1 |
| P4 | `M-T7.3-multi-target-proxy` | mission | like | language, system | L | `proxy { }` does not parse and `targets:` is still in the grammar (T7 — light pass) |
| P4 | `M-T8.1-delegating-dap` | mission | like | dap | L | The DAP server is still remap-only — no launch/attach (T8 — light pass) |
| P4 | `M-T9.15-per-pr-nonreact-fullstack` | breadth | like | vue, svelte, angular, feliz, flutter | L | M-T9.15: React is still the only frontend with a per-PR full-stack round-trip; vue/svelte/angular/feliz/flutter are nightly-or-label |
| P4 | `M-T9.26-route-target-seam` | mission | like | node, dotnet, java, python, elixir | L | M-T9.26: the `RouteTarget` HTTP-emission seam is designed and unbuilt (and its divergence census predates the route-builder unification) |
| P4 | `api-versioning-no-surface` | mission | like | api-surface, all five backends, openapi | L | API versioning has no surface at all (`api` block carries urlStyle + httpStatus + routes only) |
| P4 | `customization-cliff-study` | mission | like | react, vue, svelte, angular, feliz, flutter, heex | L | Customization cliff — no study exists of what a no-code user hits when the ~55-primitive closed set runs out |
| P4 | `infrastructure-port` | mission | like | language-surface, all five backends | L | `infrastructure-port` — the third DDD service role has no construct (deliberate usage-pulled hold) |
| P4 | `m-t2-11-encrypted-at-rest` | mission | like | node, dotnet, elixir, python, java | L | M-T2.11 `encryptedAtRest` — deliberately parked; no grammar, no IR, no code |
| P4 | `m-t2-12-money-currency` | mission | like | node, dotnet, elixir, python, java | L | M-T2.12 — `money` is a bare primitive with no currency dimension; no cross-row reporting-query surface |
| P4 | `m-t2-5-brownfield-adopt` | mission | like | cli | L | M-T2.5 brownfield adoption — nothing introspects an existing schema; `ddd adopt` does not exist |
| P4 | `m-t4-2-replay-rebuild` | mission | like | node, dotnet, elixir, python, java | L | M-T4.2 residual — projection replay/rebuild and projection snapshots are unbuilt (per-backend parity itself is done, 5/5) |
| P4 | `outbox-listen-notify` | mission | like | node, dotnet, elixir, python, java | L | M-T4.3 item 3 — every outbox/relay on every backend polls at 500 ms; LISTEN/NOTIFY is unimplemented |
| P5 | `F2-XB-5` | stale-prose/faulty-fix | prov | node, dotnet, java, python, elixir | S | RS-18 still declares the pre-#2653 `<field>_provenance` wire key — a `behavioral`-tier conformance rule that is now false on all five backends |
| P5 | `G2646-open-java-readmodel-backstop` | stale-prose | like | java | S | #2646 documented, NOT fixed: validateJavaReadModelShapes is a defensive backstop believed unreachable (verify-or-delete) |
| P5 | `M-T5.3-union-register-rows-stale` | stale-prose | like | docs, validator | S | `loom.union-unsupported` and `loom.operation-return-unsupported` can no longer fire — their register rows still describe them as per-backend gaps |
| P5 | `coverage-fleet-bug-hunt-13-live-stale` | stale-prose | prov | docs | S | coverage.md still says the fleet bug-hunt has 13 LIVE rows — the register is fully drained (M-T9.24 `done` is the true line) |
| P5 | `feliz-persist-codec-stale-code-name` | stale-prose | like | feliz | S | `feliz-persist-codec.ts` documents a diagnostic code that exists nowhere in the repo |
| P5 | `mikroorm-rename-rationale-stale` | stale-prose | prov | node | S | The mikroorm half of the self-provisioning-adapter gate rationale is factually wrong on today's emitter (`safe: true`) |
| P5 | `register-row-mikroorm-stale` | stale-prose | prov | node | S | The `loom.mikroorm-unsupported` register row still describes the deleted five-feature gate and cites a dead site + a closed owner |
| P5 | `register-rows-closed-missions` | stale-prose | like | node, dotnet, java, python, elixir | S | Six register `gap` rows are still owned by missions the track has CLOSED as premise-overturned (M-T6.32, M-T6.34) |
| P5 | `register-rows-unowned-workflow-load` | stale-prose | like | register | S | `loom.workflow-load-array-unsupported` / `-nullable-unsupported` are register rows with no `mission:` link, though M-T4.7 explicitly owns them |
| P5 | `register-site-pointers-stale` | stale-prose | like | dotnet, elixir, java, node, python, register | S | 36 of 46 `*-unsupported` register rows cite a stale `file:line` emission site; the gate only checks the string SHAPE |
| P5 | `surface-dangling-emit-hooks` | stale-prose | like | node, dotnet, java, python, elixir | S | `PlatformSurface` doc comments still reference `emitAuditInit` / `emitI18nAdapter`, hooks that do not exist |
| P5 | `t6-duplicate-heading-M-T6.43` | stale-prose | like | node, dotnet, java, python, elixir | S | T6 carries TWO `## M-T6.43` headings — the fifth dup-ID incident, and this one is on `main` |

## Conflicts (10)

### flutter-form-field-drops: HONEST vs SILENT

- **type**: kind (not state) — all three buckets agree the defect is OPEN
- **subject**: The four Flutter form-field shapes (nested VO sub-field `addr.geo`, VO array with non-scalar sub-field `lines`, bool element array `flags`, enum element array `colors`) that `test/generator/flutter/parity-freeze.test.ts` pins.
- **t1-frontend** — `M-T1.18-form-field-drops` · open · t1-frontend calls it HONEST — "loudly and frozen", the parity-freeze ratchet is real
- **fresh-gate-probe** — `flutter-form-field-drops` · open · fresh-gate-probe calls it SILENT — the marker is a Dart COMMENT emitted by forms-emit.ts:184; `ddd parse` is clean and `flutter analyze` is clean, so no `loom.*` code exists
- **pr-registers** — `G2646-open-flutter-form-field-drops` · open · pr-registers also files it SILENT
- **resolution**: Merged into ONE open row (canonical `flutter-form-field-drops`) and recorded as kind=silent, because the disagreement is settled by fact: an emitted Dart comment is not a diagnostic. The honest-side reading (a test-level ratchet exists) is preserved in the merged evidence. The fresh-gate-probe fix recipe adds a step the other two lack: raise a real `loom.flutter-form-field-unsupported` first, then build the widgets.

### HEEx/Flutter `DataGrid`: settled non-goal (done) vs open gap

- **type**: state
- **subject**: `loom.datagrid-unsupported-target` / `KNOWN_HEEX_GAPS.DataGrid`.
- **pr-registers** — `G2646-settled-nongoals` · done · pr-registers marks it DONE — #2646 audits it as by-design ("settled non-goal"), no work
- **fresh-gate-probe** — `heex-datagrid-gap` · open · fresh-gate-probe marks it OPEN — the one TSX-rendered primitive with no HEEx renderer; concedes "open here means unowned, not obviously wrong"
- **t1-frontend** — `M-T1.1-heex-datagrid-register-row` · open · t1-frontend marks it OPEN for a different reason — the decision is settled (D-DATAGRID-TARGETS) but `unsupported-register.ts:113-118` still records it kind:"gap" owned by M-T1.1, and the register's own header says a `gap` must drain to zero
- **resolution**: NOT silently resolved. Kept OPEN (canonical `heex-datagrid-gap`, with the t1 register row merged in) because two of three buckets report it open AND the actionable residue they name is bookkeeping the "done" verdict does not cover: re-kind the register row from `gap` to `scope`. If that re-kinding lands, the row closes and the "done" verdict becomes correct.

### `loom.frontend-collection-op-unsupported`: permanent gate vs largest drainable page-DSL gap

- **type**: disposition (both buckets agree state=open; they prescribe OPPOSITE actions)
- **subject**: Only `map` of the 17 stdlib collection ops is usable in page bodies (`ui-checks.ts:335` `FRONTEND_RENDERED_COLLECTION_OPS = new Set(["map"])`).
- **t1-frontend** — `M-T1.20-collection-op-gate-misclassified` · open · t1-frontend: the gate is DELIBERATE and PERMANENT (ui-checks.ts:265-328 states "The fix is the GATE, not renderers"); the bug is that the register calls it a drainable `gap` owned by M-T1.20 — the fix is to re-kind it `scope`, i.e. never implement the 16 ops
- **pr-registers** — `G2646-open-page-body-collection-ops` · open · pr-registers: #2646 calls it "the largest remaining page-DSL gap" — i.e. work to be done, 16 of 17 ops refused
- **resolution**: Both rows kept open and cross-linked. This is an OWNER decision, not a fact question: either the 16 ops become renderable on six frontends (a second expression dialect per walker) or the register row is re-kinded `scope` and the mission closes. Do not implement either half without settling it.

### Elixir × shape:document capability filters — "no regression" vs `ignoring <Cap>` silently dropped

- **type**: state (adjacent scope — partial contradiction)
- **subject**: `src/generator/elixir/vanilla/document-emit.ts` capability-filter path.
- **plan-residue** — `W2-elixir-document-capability-filter` · done · plan-residue marks the plan item DONE — the in-app filter exists, is wired at document-emit.ts:455, and the old gate pair was deleted with the last unwired cell
- **pr-registers** — `G2667-A11-elixir-document-ignoring-dropped` · open · pr-registers marks a SILENT defect OPEN in that same path — `renderDocFindFn` never threads `f.bypassAll`/`f.bypassCaps`, so an admin `ignoring <Cap>` find still filters, fail-CLOSED, with no diagnostic
- **resolution**: Not contradictory on inspection: the filter EXISTS (plan item done) but its BYPASS clause is dropped (A11 open). Both verdicts kept; A11 stays in the open list. Flagged because a reader of the plan-residue row alone would conclude this path is clean.

### Register `site:` staleness — sampled 3/3 miss vs measured 36/46 miss

- **type**: severity of the same finding (both open, same defect)
- **subject**: `UNSUPPORTED_REGISTER` rows citing a stale `file:line`; `test/system/unsupported-register.test.ts:131-136` validates only the string SHAPE.
- **t6-backend** — `register-site-lines-unverified` · open · t6-backend: sampled three rows, all three miss
- **t2-t4-data-workflow** — `register-site-pointers-stale` · open · t2-t4: ran the full check — 36 of 46 rows miss
- **resolution**: Merged into ONE open row (canonical `register-site-pointers-stale`, the quantified one); the t6 sample is preserved as corroborating evidence.

### M-T6.40 elixir non-paged list page: fleet1 `done` vs fleet2 proven residue

- **type**: state — fleet1 DONE vs fleet2 proven-faulty (class=faulty-fix)
- **subject**: The scaffolded Elixir list page under a non-paged author `find all`.
- **fleet1** — `M-T6.40` · done · fleet1: 'CLOSED; the arity is now derived, not guessed' (#2608)
- **fleet2** — `F2-MT640-SORT-DEAD` · open · fleet2: the arity IS fixed, but the page still renders sortable headers whose click is a no-op refetch — option (a) shipped without dropping the affordance
- **resolution**: row F2-MT640-SORT-DEAD stays OPEN, class=faulty-fix; the docs half (row still reading `open`) is now `done` on #2667's branch

### Elixir seeder: fleet1 `no regression` vs fleet2 whole-file drop on event-sourced

- **type**: state — fleet1 DONE/checkedOk vs fleet2 proven-faulty (class=faulty-fix)
- **subject**: `seed` emission on platform: elixir.
- **fleet1** — `W1-elixir-seeder / M-T6.37` · done · fleet1: 'platform: elixir emits a real seeder — no regression' / 'SHIPPED and acceptance-tested'
- **fleet2** — `F2-SEED-EVENTSOURCED` · open · fleet2: on an event-sourced aggregate elixir emits NO seeder file at all, and in the mixed case emits a PARTIAL dataset then commits the ship-once marker — the row can never be applied
- **resolution**: F2-SEED-EVENTSOURCED OPEN, class=faulty-fix; fleet1's verification never crossed the persistedAs axis

### Code-point `.length`: fleet1 `landed` vs fleet2 Angular never reached

- **type**: state — fleet1 DONE (with a named residual) vs fleet2 proven new hole
- **subject**: Code-point vs UTF-16/grapheme length semantics.
- **fleet1** — `W2-codepoint-length-validation` · done · fleet1: 'landed on node/.NET/java, native on python; elixir is a signed grapheme residual' — frontends not examined
- **fleet2** — `F2-XB-2` · open · fleet2: generated Angular forms still validate length in UTF-16 code units via Validators.minLength/maxLength
- **resolution**: F2-XB-2 OPEN, class=faulty-fix (incomplete fix); F2-XB-8 (elixir graphemes) stays the acknowledged residual

### Provenanced<T> carrier: fleet1 `reaches all five backends and all seven frontends` vs fleet2 stale governing rule

- **type**: state — fleet1 DONE vs fleet2 proven-faulty (class=faulty-fix)
- **subject**: #2653's Provenanced<T> wire carrier.
- **fleet1** — `provenanced-carrier-all-targets / M-T6.12` · done · fleet1: emission verified on all five backends and all seven frontends
- **fleet2** — `F2-XB-5` · open · fleet2: RS-18 in test/conformance/semantics-rules.ts still declares the DELETED `<field>_provenance` key and asserts conforms:[all five] — a behavioral-tier rule now false everywhere, and nothing binds its observable
- **fleet2** — `F2-XB-7` · open · fleet2: `lineage` is published non-nullable in .loom/wire-spec.json and elixir OpenApiSpex while every backend serializes null
- **resolution**: both OPEN; fleet1's row `provenanced-bare-read-in-page-body` is the third residue of the same merge

### `httpStatus NotFound -> N`: fleet1 `honoured on all five — no regression` vs fleet2 blob-404 collateral

- **type**: state — fleet1 checkedOk vs fleet2 proven-faulty (class=faulty-fix)
- **subject**: The NotFound rung remap.
- **fleet1** — `W2-notfound-status-override` · done · fleet1: '`httpStatus NotFound -> N` is honoured on all five backends — no regression'
- **fleet2** — `F2-W-13` · open · fleet2: the remap ALSO retargets the objectStore blob-absence 404 on all five, which src/ir/util/openapi-errors.ts:148-153 explicitly promises stays literal
- **fleet2** — `F2-XB-1 / F2-W-02` · claimed · fleet2 independently re-proved the elixir title divergence (= #2667 §B1) at both 410 and 409
- **resolution**: F2-W-13 OPEN; the title half is claimed by #2667

## checkedOk summary

146 entries. Fleet-2 contributed 114 empirically re-verified 'sound' checks across its 8 buckets; fleet-1 contributed 32 done/no-regression verifications.

Five of those verifications are **contradicted** by a fleet-2 proof and are listed in Conflicts above (M-T6.40, the elixir seeder, code-point `.length`, the Provenanced<T> carrier, and the NotFound rung remap). Treat any single-fleet 'checked OK' as scoped to the axis that fleet actually crossed.

| source | entries |
|---|---|
| fleet1:done | 32 |
| fleet2:fix-adapters | 14 |
| fleet2:fix-crosscut | 12 |
| fleet2:fix-elixir | 16 |
| fleet2:fix-frontends | 15 |
| fleet2:probe-combos-backend | 13 |
| fleet2:probe-combos-frontend | 17 |
| fleet2:probe-expr-stmt | 13 |
| fleet2:probe-wire-openapi | 14 |

