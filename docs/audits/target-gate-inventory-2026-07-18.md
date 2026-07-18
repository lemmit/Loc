# Target gate inventory — every `loom.*-unsupported`, re-verified

**Snapshot date:** 2026-07-18 · **Against:** fresh `main` @ `8814202` (source-grounded, not doc-sourced)

This audit answers one question honestly: *of the "unfinished features" across Loom's
five backends and five frontends, which are real closeable gaps, which are correct
guards against impossible models, and which are deliberate policy?* It was prompted by a
target-removal evaluation whose first-pass claims leaned on a **frozen** doc
(`docs/old/plans/vanilla-phoenix-gaps.md`) and got two things wrong. Everything below is
re-checked against the emitters/validators as they ship today.

## Method

- Enumerated every **live-emitted** diagnostic: `grep 'code: *"loom\.[a-z0-9-]*unsupported"' src/` — a code that only appears in a comment or test is *not* counted (that filter alone demoted `loom.java-single-containment-unsupported`, which is dead: `system-checks.ts:1129` "(Was: …)").
- Read each gate's message + surrounding rationale in `src/ir/validate/checks/`.
- Mapped each to its live mission in `docs/new-plan/` (or flagged it untracked).

## Taxonomy

### A. Correct guards against impossible/nonsensical models — **not gaps, no action**

| Gate | What it actually rejects |
|---|---|
| `java`/`dotnet`/`node`/`python`/`elixir`-`stamp-unsupported` (×5) | **Stamps are implemented on all five backends** (`system-checks.ts:1002-1021` — Java `_stampOnCreate`, .NET `AuditableInterceptor`, node `_stampOnCreate`, python pre-persist, Elixir `put_change`). The gate fires only for two models that *cannot* work: a `currentUser` stamp on a deployable with **no auth** (no request principal to stamp from), or a stamp on an **event-sourced** aggregate (state is folded from events, not field-stamped). |
| `java-workflow-instance-field-unsupported`, `java-projection-field-unsupported` | Explicitly **unreachable defensive backstops** (`system-checks.ts:1136-1208`) for an entity-typed read-model field — a shape the grammar/scope already forbids. Kept so the shape fails honestly if a scope rule ever changes. |

> ⚠️ **Correction to an earlier claim:** "stamps are a feature no backend implements"
> is **false**. Stamps ship everywhere; the five `*-stamp-unsupported` gates guard two
> impossible configurations, nothing more.

### B. Deliberate honest limits — resolved as intentional (mission `done`)

| Gate | Disposition |
|---|---|
| `feliz-async-effect-unsupported` | M-T6.15 (`done`) — async effects on the Feliz/Elmish frontend are *honestly gated by design*, with a clear "drive the op through a form primitive" message (`store-checks.ts:365`). The gate **is** the deliverable, not a missing feature. |

### C. Subset-ORM gates — **DECIDED 2026-07-18: DRAIN to full parity**

| Gate | Disposition |
|---|---|
| `dapper-unsupported` (.NET) | M-T6.9 — Dapper is the **v1 subset** alternate to the default EF Core. **Being drained to full parity.** |
| `mikroorm-unsupported` (**Node**, not .NET) | M-T6.9 — MikroORM is the **Node** subset alternate to the default Drizzle. **Being drained to full parity.** |

The owner's call: fully support both, don't declare them final. After draining, each gate
survives only as a fail-fast for genuinely-impossible shapes (like the category-A stamp
gates), not as a subset boundary. See the **Drain plan** below.

#### Drain plan (M-T6.9 → `in-progress`)

Source-grounded rejection worklist (`validateDapperSupport` `system-checks.ts:1686`,
`validateMikroOrmSupport` `:1786`):

| Feature | Dapper (.NET) | MikroORM (Node) |
|---|:--:|:--:|
| `seed` data | drain | drain |
| non-relational `shape(embedded)`/`shape(document)` | drain | drain |
| aggregate inheritance (`abstract`/`extends`) | drain | drain |
| nested entity parts (`contains`) | drain | drain |
| reference-collection associations (`Id[]`) | ✓ done | drain |
| `filter` capability predicates | principal only | all |
| principal-referencing stamp values | drain | ✓ done |
| provenanced fields | drain | drain |
| server-managed access (`token`/`internal`/`secret`) | ✓ done | drain (except stamp/version) |
| workflow event subscriptions / outbox | drain | verify |
| find-predicate SQL subset | widen `whereToSql` | widen `whereToMikroFilter` |

Sequencing principle: land **one feature × one adapter per slice**, each behind its own
`dotnet-build` (Dapper) or node build+e2e (MikroORM) fixture, easiest/highest-value first,
architecturally-hard raw-SQL cases (Dapper `shape(document)` jsonb, TPH/TPC inheritance)
last. MikroORM is a full data-mapper (native STI, embeddables, collections), so several of
its slices are cheaper than the raw-SQL Dapper equivalents. Detailed per-feature reference
impls + final slice order are being mapped (two scoping passes over the emitters) and will
be appended here before the first implementation slice lands.

### D. Genuine closeable feature gaps — **tracked**

| Gate / gap | Backend | Scope | Mission |
|---|---|---|---|
| `java-fullstack-unsupported` | Java | `hosts:` a *separate* react-deployable bundle (the embedded `ui:` SPA mount already works; dotnet ships the `hosts:` form) | **M-T6.5** (`open`, P3) |
| `vanilla-document-unsupported` | Elixir | `shape(document)` emits scalar finds + named ops but not audited/provenanced ops, collection mutation, VO/derived/function reads, or non-scalar find predicates | **M-T6.2** (§12 residual, `open`) |
| `vanilla-containment-unsupported` | Elixir | deep **part-in-part** nesting on a *relational* shape (single-level nested parts already emit child tables; `shape(embedded)` folds the whole graph) | **M-T6.2** (§11c residual, `open`) |
| Phoenix `mix format` cleanliness | Elixir | generated output is not `mix format`-clean → no format/Credo/Dialyzer gate | **M-T6.3** (`open`, P2) |

### E. Genuine closeable feature gap — **UNTRACKED** (this audit's finding)

| Gate | Backend | Scope | Mission |
|---|---|---|---|
| `java-embedded-refcoll-unsupported` | Java | a `shape(embedded)` aggregate with a `X id[]` **reference collection** — jsonb id-array columns are unmapped because Hibernate's structured-JSON path bypasses the Jackson `FormatMapper` for `@Embeddable` ids (`system-checks.ts:1104-1123`). Workarounds exist (`shape(document)`, relational shape, node/dotnet host). | **none → propose M-T6.19** |

## Plan

The list of *genuinely* actionable items is short — the honest-gate discipline means most
"unfinished" surface is deliberate. In priority order:

1. **Track the one orphan.** Add **M-T6.19 — Java `shape(embedded)` jsonb id-array
   reference collections** to `docs/new-plan/T6-backend-parity.md` (a converter-based
   `@Convert` mapping so the id-array routes through the Jackson `FormatMapper`; +1
   generator test on the gated `java-build` fixture, remove the gate on landing).
   Size **M**, P3 — same tier as the sibling Java gaps.
2. **M-T6.3 (Phoenix `mix format`)** — re-confirmed still real on 2026-07-18: 11/26
   generated `lib/*.ex` files carry lines over the 98-col default. Emitter formatting
   cleanup across the vanilla + shell `lines(...)` callers first, then activate the
   `LOOM_PHOENIX_FORMAT` gate. Size **M**.
3. **M-T6.9 (subset-ORM drain)** — DECIDED: drain Dapper/MikroORM to full parity. Large
   multi-slice track (see Drain plan above); land one feature × one adapter per slice.
4. **M-T6.5 / M-T6.2 residuals** — proceed as already sequenced; all narrow, all with
   documented workarounds, none blocking.
5. **No action** on category A (correct guards) or B (deliberate limits). Do **not**
   "fix" the stamp or java-read-model backstops — they guard shapes that cannot work.

## Corrections this audit forced (to prior claims / a frozen doc)

- **`vanilla-phoenix-gaps.md` §6 (SPA embed) is CLOSED**, not "REAL — react path also
  unwired." It shipped in **#1886 / M-T6.1**: `vanilla/index.ts:320-328` dispatches
  `generate{React,Vue,Svelte}ForContexts`, `shell-emit.ts:104` emits
  `renderVanillaSpaController`, plus the `Plug.Static` `/app` mount and Dockerfile SPA
  stage. The frozen doc's "`renderSpaController` … is dead code" references a function
  that **no longer exists** (deleted in the #1897 dead-export sweep; the live emitter is
  `renderVanillaSpaController`).
- **Java has 5 live target gates, not 6** — `java-single-containment-unsupported` is dead.
- **`mikroorm-unsupported` is a Node gate, not .NET** (`persistence-surface.ts:5`:
  `efcore`/`dapper` on .NET; `drizzle`/`mikroorm` on Node).
- The live roadmap (`T6-backend-parity.md`, `coverage.md`) was **already accurate** on
  every point above; only the frozen archived doc and doc-sourced summaries were stale.
