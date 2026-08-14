# Platform parity debt — the cross-backend gate inventory

> [!IMPORTANT]
> **ARCHIVED / SUPERSEDED (2026-07-13).** This document's statuses, orderings, and
> registers are frozen and no longer maintained. The live roadmap is
> [`docs/new-plan/README.md`](../../new-plan/README.md); this file's open items are
> dispositioned in [`docs/new-plan/coverage.md`](../../new-plan/coverage.md).
> Use this file only as the design record.

> **Status:** SUMMARY / debt register — no new surface; tracks existing gates.
> **Role:** A single roll-up of every feature that works on some targets but
> not others, across the **five backends** (node/Hono, dotnet/.NET, java/Spring,
> python/FastAPI, elixir/Phoenix) and the frontends — **five** when this file was
> written (React, Vue, Svelte, Angular, Feliz); **six** today, Flutter having
> shipped since (see the 2026-08-14 correction below) — plus the Phoenix-HEEx
> render path. It exists so the parity gaps that are otherwise
> scattered across per-feature proposals and validator codes have one home to
> prioritise against. Each row links to the proposal that owns the fix.
> **Authoritative detail:** the code-verified, file-and-line snapshots live in
> [`../audits/backend-feature-parity-2026-06.md`](../../audits/backend-feature-parity-2026-06.md)
> (backends) and
> [`../audits/frontend-parity-audit-2026-07.md`](../../audits/frontend-parity-audit-2026-07.md)
> (frontends — refreshes the 2026-06 pass, adds Feliz). When this précis and those audits disagree, the audit (and the
> cited code) wins. The older [`gated-features-inventory.md`](../../audits/gated-features-inventory.md)
> (2026-06-03) is **superseded** — it predates the java/python backends.

> **[2026-06-24 refresh]** Widened from the old four-column
> (node/dotnet/phoenix/react) matrix to the current five-backend world, and the
> debt list re-grounded against fresh `main`. **Most of the old register has
> drained:** TPH (all five), event sourcing (aggregates *and* workflows),
> `shape(document)`, provenance, per-op + lifecycle `audited`, `ignoring`
> filter-bypass, and `X id[]` reference collections are now uniform across the
> backends (elixir reaching them via its **vanilla** foundation). On the
> frontend, the `Section`/`Sticky` codegen crash is fixed and `primeng`/`spartanNg`
> shipped, so the only residue there is pack breadth. The standing backend debt
> is now narrow: **python filter depth** and the **minimal alternate adapters**.

> **[2026-08-14 correction]** Re-verified against fresh `main` (`ae0cb24`). The
> register had rotted again; the rows below are corrected in place, each with the
> code that now contradicts them. **Drained since the 2026-06-24 refresh:**
> Feliz's page-primitive coverage (47 of 48 pack-dispatched primitives, the
> "🔴 20/44" silent gap closed — M-T6.15/M-T1.4); the Feliz runtime-e2e gate
> (folded into `generated-feliz-build.yml`); the `store` `persist:` lifetime
> ladder (`loom.store-lifetime-unsupported` retired); python's `shape(document)`
> capability filters (M-T6.6); and most of the `dapper`/`mikroorm` reject lists
> (M-T6.9, 9 waves). **Two structural notes:** (1) the reserved-hooks section
> described `PlatformSurface` methods that never existed — only `emitProject`
> does; (2) the **frontend matrix is frozen at 2026-07** and has no Flutter
> column, though Flutter ships as a full sixth frontend
> (`src/generator/flutter/`, `generated-flutter-build.yml`, a `flutter` row in
> `render-degradation.test.ts`). Do not re-derive a five-frontend world from it —
> for the live frontend picture read
> [`../audits/frontend-parity-audit-2026-07.md`](../../audits/frontend-parity-audit-2026-07.md)
> plus the T1 missions (Flutter's own live debt is
> [`docs/new-plan/T1-ui-frontend.md`](../../new-plan/T1-ui-frontend.md) § M-T1.18).

**A note on the elixir foundation.** The Ash foundation was removed —
`platform: elixir` now generates plain Phoenix LiveView on Ecto (the `vanilla`
foundation, the only one; `foundation: ash` is a hard validation error). So this
register treats elixir as a single backend whose foundation is `vanilla`; the
old "✓ vanilla / ✗ ash" foundation-split caveats are gone.

Legend: ✓ implemented · ✗ gated (fail-fast validator error) · ⚠ partial / stub · N/A.

## Backend matrix at a glance

Gate sets read from `src/ir/validate/checks/{system,structural}-checks.ts` and
`src/util/platform-axes.ts` (line numbers re-synced 2026-06-24 — they drift, so
re-derive before trusting a row). "elixir" = the `vanilla` foundation unless the
cell notes otherwise.

| Feature | node | dotnet | java | python | elixir | Gate · source of truth |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✓ | ✓ | ✓ | `EVENT_SOURCING_BACKENDS` · system-checks.ts:1913 |
| Event-sourced **workflow** (saga appliers) | ✓ | ✓ | ✓ | ✓ | ✓ | `EVENT_SOURCING_WORKFLOW_BACKENDS` · system-checks.ts:2014 |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | `TPH_CAPABLE` · system-checks.ts:1862 |
| TPC inheritance `inheritanceUsing(ownTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | (universal) |
| `shape(document)` persistence | ✓ | ✓ | ✓ | ✓ | ✓ | `PLATFORM_SAVING_SHAPES` · platform-axes.ts:40 |
| `shape(embedded)` persistence | ✓ | ✓ | ✓ | ✓ | ✓ | `PLATFORM_SAVING_SHAPES` · platform-axes.ts:40 |
| Discriminated unions / generic carriers / `when` gate | ✓ | ✓ | ✓ | ✓ | ✓ | structural-checks.ts:414 / :232 / :484 |
| Exception-less returns (`op(): X or NotFound`) | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_RETURN_BACKENDS` · structural-checks.ts:518 |
| Non-principal capability `filter` (relational) | ✓ | ✓ | ✓ | ✓ | ✓ | `LIMITED_FAMILIES` · system-checks.ts:1006 |
| Principal `filter` (`currentUser`/tenancy, relational) | ✓ | ✓ | ✓ | ✓ | ✓ | `supportsPrincipalFilter` · system-checks.ts:1021 |
| **Filter on non-relational shape** (doc/embedded) | ✓ | ✓ | ✓ | ✓ | ⚠ embedded | `supportsNonRelationalFilter` · system-checks.ts:2125 |
| `ignoring <Cap>` filter-bypass | ✓ | ✓ | ✓ | ✓ | ✓ | `FILTER_BYPASS_FAMILIES` · system-checks.ts:1199 |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✓ | ✓ | ✓ | `PROVENANCE_BACKENDS` · system-checks.ts:2063 |
| Per-operation `audited` | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_OP_BACKENDS` · system-checks.ts:2124 |
| Audited **lifecycle** (`audited create`/`destroy`) | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_LIFECYCLE_BACKENDS` · system-checks.ts:2125 |
| `X id[]` reference collections | ✓ | ✓ | ✓ | ✓ | ✓ | not gated — emitted + boot-verified on all 5 |

The elixir column is fully ✓ — every feature in this matrix emits on the vanilla
foundation (the only elixir foundation since Ash was removed).

**The standing backend debt:**

1. **`shape(document)` filters — narrowed to elixir only** *(corrected
   2026-08-14)*. A capability `filter` on a `document` aggregate now emits on
   node, .NET, java **and python** (`supportsNonRelationalFilter`,
   `system-checks.ts:2125`; python's in-app blob filter is
   `documentCapabilityBody`, `src/generator/python/find-predicate.ts:557`), and
   the **principal** case emits on those same four
   (`supportsPrincipalNonRelationalFilter`, :2152 — python binds
   `current_user = require_current_user()` before its list-comprehension
   filter). What the row said — "gated on python and elixir … elixir has no
   `document` shape at all" — was wrong on both counts: elixir *does* support
   `shape: document` (plain Ecto's opaque `(id, data, version)` table +
   schemaless-changeset fold, `system-checks.ts:1447`); what it lacks is the
   **in-app capability-filter evaluation over the rehydrated document**, which is
   the one remaining cell. ([multi-tenancy-design-note](./multi-tenancy-design-note.md),
   DEBT-02; live mission: `docs/new-plan/T6-backend-parity.md` M-T6.6, whose
   python half is now `done`.)
2. **Minimal alternate adapters** — largely drained by M-T6.9 (9 waves) and
   M-T6.23/M-T6.25; see the corrected adapter sub-matrix below.
   ([platform-realization-axes](./platform-realization-axes.md).)

> **Python filter depth is now CLOSED** (DEBT-02). The non-principal relational
> case (#1481/W1a), the **principal** relational case (#1549), and **both
> `shape(embedded)` cases** (#1571) all emit — python's filter surface now
> matches node/java for relational + embedded. `contextFilterPredicate`
> (`src/generator/python/find-predicate.ts`) AND-s the predicate into every root
> read; principal predicates render `require_current_user().<claim>` against the
> ambient `ContextVar` accessor. Only `shape(document)` remains (item 1 above).
> **Event-sourced workflows on elixir** also drained — they ship on
> `elixir·vanilla` (gated on ash, foundation-fit), so no feature in this matrix
> is gated on *both* elixir foundations.

## Frontend matrix at a glance

> **FROZEN AT 2026-07 — no Flutter column** *(marked 2026-08-14)*. Flutter
> (Dart + Riverpod) shipped after this table was written and is a full sixth
> frontend — `src/generator/flutter/` (its own procedural pack, walker target,
> i18n and parity modules), `.github/workflows/generated-flutter-build.yml`
> (`flutter analyze` + a headless `flutter test` runtime smoke + `flutter build
> web` + an Android `build apk` leg), and a `flutter` row in
> `test/generator/_walker/render-degradation.test.ts`. The cells below are
> corrected where they were provably stale, but the table is **not** a
> six-frontend inventory and must not be read as one. Live sources:
> [`../audits/frontend-parity-audit-2026-07.md`](../../audits/frontend-parity-audit-2026-07.md)
> and the T1 missions ([`T1-ui-frontend.md`](../../new-plan/T1-ui-frontend.md)
> § M-T1.18 for Flutter's own debt — the M-A form-field drops, realtime, and the
> iOS / on-device gates).

Five JSX/markup-class frontends plus a sixth F#/Fable target. The four JSX/markup
targets (React/Vue/Svelte/Angular) share one walker core; **Feliz (F#/Fable/Elmish)**
also drives `walkBody` but emits F# via an F# expression-leaf table; Phoenix-HEEx
runs a parallel core off the same primitive table. Contract-level parity is
**strong** — all required `WalkerTarget` seams (incl. the expression-syntax leaf
seam) are implemented on all five frontends, HEEx primitive parity is complete
(`KNOWN_HEEX_GAPS` empty), and forms/realtime/views/workflows/layouts/auth are
uniform. ~~The exception is Feliz's page-primitive coverage — a 🔴 silent gap.~~
*(2026-08-14: closed — see the corrected cells under the table.)*

| Concern | React | Vue | Svelte | Angular | Feliz | Phoenix-HEEx |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| pack-dispatched page primitives ship | ✓ (gate) | ✓ (gate) | ✓ (gate) | ✓ (gate) | ✓ (47/48) | ✓ |
| `store` UI primitive | ✓ Zustand | ✓ Pinia | ✓ runes | ✓ signals | ✓ Elmish Model | ✓ LiveView struct |
| Build CI gate | ✓ | ✓ | ✓ | ✓ | ✓ (curated) | (elixir build) |
| Runtime-e2e CI gate | ✓ | ✓ | ✓ | ✓ | ✓ (in the build workflow) | n/a |
| Design system | 4 packs | 2 packs | 2 packs | 3 packs | daisyUI theme | 2 packs (coreComponents/daisyui) |

*Corrected cells (2026-08-14, code-verified on `ae0cb24`).* **Feliz primitives:**
`feliz/pack.ts` implements 47 `primitive-*` renderers against mantine v9's 48;
the only difference is `primitive-form-of`, which Feliz forks entirely
(`feliz/index.ts` — "not pack field-input/form-of templates"). The
`(* feliz pack: no renderer *)` sentinel survives as a safety net and is now
*covered*: it is listed in `FALLBACK_MARKERS`
(`test/conformance/frontend-showcase-render.test.ts`) — the exact escape this
document named as missing — and `KNOWN_DEGRADATIONS`
(`test/generator/_walker/render-degradation.test.ts`) is **empty**, its last two
entries deleted by their fix. **Feliz runtime e2e:**
`generated-feliz-build.yml` runs `vite preview` +
`playwright install --with-deps chromium` + headless smokes over the example,
scaffold and auth-gated scenarios; the workflow header says so outright ("the
runtime e2e the other frontends get from `generated-{vue,svelte}-e2e.yml`, folded
in here to reuse the single slow `dotnet fable` step"). It is a real gate — it
just does not live in a separate `-e2e.yml`.

**The standing frontend debt:**

0. ~~**🔴 Feliz drops 24 page primitives silently** (HIGH — the one correctness
   bug).~~ **CLOSED (M-T6.15 / M-T1.4; confirmed 2026-08-14.)** The premise —
   "20 of 44 rendered, the rest emit `(* feliz pack: no renderer *)`, and the
   sentinel escapes both the load-time `REQUIRED_PRIMITIVES` gate and the
   showcase render matrix" — no longer holds on either half: coverage is 47/48
   (the 48th is deliberately forked) and the sentinel is in `FALLBACK_MARKERS`.
   The original write-up + repro is kept as the design record:
   [`../audits/frontend-parity-audit-2026-07.md`](../../audits/frontend-parity-audit-2026-07.md)
   §F1.
1. **Pack breadth is uneven** (LOW, not a correctness bug) — React has 4 pack
   families / 8 versions; Vue and Svelte have 2 each; Angular has 3
   (`angularMaterial`, `primeng`, `spartanNg` — the latter two **shipped**, no
   longer grammar-reserved). Within a frontend every pack is systems-equivalent;
   they diverge only in design-system identity. ([design-packs](../../design-packs.md).)
2. ~~**`store` persist/sync ladder** — the `store` primitive is v1 in-memory on
   all five targets; `persist:`/`sync:` parse but stay validator-gated
   (`loom.store-lifetime-unsupported`).~~ **CORRECTED 2026-08-14 (M-T1.9 is
   `done`).** The lifetime ladder (`persist: memory|local|session|url`) ships on
   every frontend and `loom.store-lifetime-unsupported` is **retired** — the code
   no longer raises it (`src/ir/validate/checks/store-checks.ts` says so in both
   its header and the loop where the gate used to sit). What survives is narrower
   and different: `loom.store-lifetime-invalid` (a malformed `persist:` value,
   rejected at the AST tier in `validators/ui.ts`), `loom.store-url-field-invalid`
   (a `persist: url` store carrying an array / entity / value-object field, which
   has no round-trippable query encoding), and the LiveView-only cross-store gate
   `loom.store-cross-store-on-liveview-invalid` — a store action calling a
   *different* store's action on a `phoenixLiveView` deployable, where each store
   is seeded as its own per-page assign and so has no handle to a sibling's
   struct.

## Adapter sub-matrix

Within a backend, persistence is pluggable. The minimal-v1 adapters reject a
slice of model features (fail-fast, `loom.<adapter>-unsupported`).

> **[2026-08-14 correction]** The lists below were the **2026-06** minimal-v1
> scope and are almost entirely drained — M-T6.9 ("Dapper/MikroORM → full
> parity", 9 waves) is `done`, plus M-T6.23 slices. Both `validateDapperSupport`
> and `validateMikroOrmSupport` now annotate each formerly-rejected feature as
> *supported* in the function body itself; read those two functions, not this
> section, for the live scope. **The live cells:**
>
> - **`dapper` (dotnet)** — rejects (a) a **query-time projection**
>   (`query-projection-emit.ts` has no dapper branch and would emit the EF shape,
>   so the project would not compile — M-T6.25), and (b) a **hierarchical
>   (deep/global) tenancy scope filter**, whose materialized-path sentinel the
>   principal-param collector cannot bind (M-T6.29). Everything the old list
>   named — `retrieval` bundles, `seed` data, workflow event subscriptions /
>   channels / outbox, `shape: document` **and** `shape: embedded`, TPC **and**
>   TPH inheritance, `X id[]` associations, nested parts incl. part-in-part,
>   principal stamps/filters, provenanced fields — is now emitted.
> - **`mikroorm` (node)** — rejects (a) **query-time projections** (folded
>   projections work; only the query-time comprehension is missing), (b) the
>   **realtime SSE wire** for a `delivery: broadcast` channel (error when a
>   frontend targets the backend, warning when nothing observes it — the
>   fold/saga routing half is unaffected), and (c) **nested parts on an abstract
>   aggregate-inheritance base** (the base owns no repository, so its part tables
>   would have no reader/writer). Auditing, `retrieval` bundles, `seed` data, the
>   transactional outbox, **timers** (M-T6.23 slice 3, #2525), every saving shape
>   incl. `document`/`embedded`, `X id[]`, capability `filter`s and
>   server-managed access are all supported. (M-T6.23 tracks the residue.)
> - ~~**`marten` (dotnet)**, **`style: cqrs` (node)**, **`style: layered`
>   (dotnet)** are reserved stubs.~~ **GONE.** Every reserved stub adapter was
>   removed with the realization-axis pruning: `src/platform/adapter-metadata.ts`
>   declares `stub: []` for every backend on every axis, `marten` is absent
>   entirely, and `cqrs`/`layered` are the *real* (and only) style values for
>   dotnet / node-elixir-java respectively.

*Historic (2026-06 minimal-v1 scope, superseded by the note above):*

- **`mikroorm` (node)** — auditing is now **supported** (#1565, persist-time
  stamping via `em.upsert` + `onConflictExcludeFields`; previously gated off).
  Still rejects: `retrieval` query bundles, `seed` data, non-relational shapes
  (doc/embedded), aggregate inheritance, `X id[]` associations, nested parts, any
  capability `filter`, provenanced fields, non-stamp server-managed fields.
  (`validateMikroOrmSupport`, system-checks.ts:1469.)
- **`dapper` (dotnet)** — supports event sourcing, `retrieval` bundles, `X id[]`
  associations, non-principal stamps/filters, access-modifier fields. Rejects:
  `seed` data, workflow event subscriptions, non-relational shapes, aggregate
  inheritance, nested parts, principal-referencing stamps/filters, provenanced
  fields. (`validateDapperSupport`, system-checks.ts:1369.)

The drizzle (node) and EF Core (dotnet) full-surface adapters are the reference;
node's `auditable` stamping moved into the persistence layer on **both** adapters
(#1554 drizzle, #1565 mikroorm — `db/audit-stamp.ts` reads the ambient
`requestContext().actorId`, dropping the operation-time `_stampOn` methods).

## Reserved-but-unwired cross-cutting hooks

> **[2026-08-14 correction] Those five hooks do not exist and never did.**
> `PlatformSurface` (`src/platform/surface.ts`) declares exactly **one** `emit*`
> method — `emitProject`; `emitAuthGate` / `emitCompliancePolicy` /
> `emitTenancyFilter` have **zero** occurrences anywhere in `src/`, and
> `emitAuditInit` / `emitI18nAdapter` appear only inside the doc comments of the
> data slots below. What is genuinely **reserved-but-unwired** is three optional
> **data slots** on `ComposeServiceShape`, undefined on every backend, which the
> compose orchestrator simply skips when absent:
>
> - `auditSidecar` — a separate container for the audit subsystem (e.g. a log
>   aggregator draining audit-record events).
>   ([audit-and-logging](./audit-and-logging.md).)
> - `policyInitCmd` — an entrypoint wrapper run before the main service to load /
>   verify compliance policies.
>   ([sensitivity-and-compliance](./sensitivity-and-compliance.md),
>   [authorization](./authorization.md).)
> - `i18nCatalogDir` — the in-container mount path for the i18n catalog
>   directory. ([i18n](./i18n.md).)
>
> The corresponding mission, `docs/new-plan/T6-backend-parity.md` § M-T6.11, has
> been corrected to match. The tenancy row had no reservation at all: multi-tenant
> filtering ships through the capability/stance machinery, not a surface hook
> ([multi-tenancy-design-note](./multi-tenancy-design-note.md),
> [`docs/tenancy.md`](../../tenancy.md)).

*Historic claim (superseded):* `PlatformSurface` declares five optional lifecycle
hooks, undefined on every backend today — `emitAuthGate`, `emitAuditInit`,
`emitCompliancePolicy`, `emitTenancyFilter`, `emitI18nAdapter`.

## Suggested prioritisation

Ordered by blast radius — how many real models the gap blocks today:

1. **`shape(document)` filters** — ~~wire the in-app filtering path on python~~
   *(python landed — M-T6.6; corrected 2026-08-14)*. The one remaining cell is
   **elixir**: a `document` aggregate there persists fine, but no in-app
   capability-filter evaluation runs over the rehydrated document.
   ([multi-tenancy-design-note](./multi-tenancy-design-note.md).)
2. **Frontend pack breadth** — ship more Vue/Svelte pack families to match
   React's depth; not a correctness item. ([design-packs](../../design-packs.md).)
3. ~~**Alternate adapters** — promote `dapper`/`mikroorm` past minimal-v1 …
   implement or remove the `marten`/`cqrs`/`layered` stubs.~~ **Done /
   moot (2026-08-14):** M-T6.9 promoted both adapters (9 waves) down to the
   handful of cells listed in the adapter sub-matrix correction above, and the
   reserved stub adapters were removed from the language entirely — those clauses
   no longer parse. ([platform-realization-axes](./platform-realization-axes.md).)

The hard rule the gates already enforce: an unsupported combination must **fail
fast at validate time** (with a `loom.*-unsupported` code), never silently
downgrade. The `test/platform/backend-parity-gates.test.ts` guardrail (#1493)
mechanically forbids the silent-gap footgun — every (capability × backend) must
be GATED or REALISED, never neither. Any new parity work inherits that contract.
