# Platform parity debt — the cross-backend gate inventory

> **Status:** SUMMARY / debt register — no new surface; tracks existing gates.
> **Role:** A single roll-up of every feature that works on some targets but
> not others, across the **five backends** (node/Hono, dotnet/.NET, java/Spring,
> python/FastAPI, elixir/Phoenix) and **five frontends** (React, Vue, Svelte,
> Angular, Phoenix-HEEx). It exists so the parity gaps that are otherwise
> scattered across per-feature proposals and validator codes have one home to
> prioritise against. Each row links to the proposal that owns the fix.
> **Authoritative detail:** the code-verified, file-and-line snapshots live in
> [`../audits/backend-feature-parity-2026-06.md`](../../audits/backend-feature-parity-2026-06.md)
> (backends) and
> [`../audits/frontend-parity-audit-2026-06.md`](../../audits/frontend-parity-audit-2026-06.md)
> (frontends). When this précis and those audits disagree, the audit (and the
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
| **Filter on non-relational shape** (doc/embedded) | ✓ | ✓ | ⚠ doc+embedded | ⚠ embedded | ⚠ embedded | `supportsNonRelationalFilter` · system-checks.ts:1051 |
| `ignoring <Cap>` filter-bypass | ✓ | ✓ | ✓ | ✓ | ✓ | `FILTER_BYPASS_FAMILIES` · system-checks.ts:1199 |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✓ | ✓ | ✓ | `PROVENANCE_BACKENDS` · system-checks.ts:2063 |
| Per-operation `audited` | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_OP_BACKENDS` · system-checks.ts:2124 |
| Audited **lifecycle** (`audited create`/`destroy`) | ✓ | ✓ | ✓ | ✓ | ✓ | `AUDIT_LIFECYCLE_BACKENDS` · system-checks.ts:2125 |
| `X id[]` reference collections | ✓ | ✓ | ✓ | ✓ | ✓ | not gated — emitted + boot-verified on all 5 |

The elixir column is fully ✓ — every feature in this matrix emits on the vanilla
foundation (the only elixir foundation since Ash was removed).

**The standing backend debt:**

1. **`shape(document)` filters** — a capability `filter` on a `document`
   aggregate is gated on python and elixir (the blob is one JSONB column, not
   per-field queryable, so it needs in-app filtering — node/java do it via
   `.stream().filter`; elixir has no `document` shape at all). Principal filters
   on `document` stay gated everywhere (the actor + json intersection isn't
   wired). ([multi-tenancy-design-note](./multi-tenancy-design-note.md), DEBT-02.)
2. **Minimal alternate adapters** — `dapper` (dotnet) / `mikroorm` (node) reject
   a slice of model features; the `marten`/`cqrs`/`layered` stubs are unwired.
   See the adapter sub-matrix below. ([platform-realization-axes](./platform-realization-axes.md).)

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

Five frontends; the four JSX/markup targets (React/Vue/Svelte/Angular) share one
walker core, Phoenix-HEEx runs a parallel core off the same primitive table.
Contract-level parity is **strong** — all 17 required `WalkerTarget` seams are
implemented on all four JSX targets, HEEx primitive parity is complete
(`KNOWN_HEEX_GAPS` empty), and the cross-cutting feature set (forms, realtime,
views, workflows, layouts, auth, e2e surface) is uniform.

| Concern | React | Vue | Svelte | Angular | Phoenix-HEEx |
|---|:---:|:---:|:---:|:---:|:---:|
| 52 walker primitives (incl. `Section`/`Sticky`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `store` UI primitive (5th target #1564) | ✓ Zustand | ✓ Pinia | ✓ runes | ✓ signals | ✓ LiveView struct |
| Build CI gate | ✓ | ✓ | ✓ | ✓ | (elixir build) |
| Runtime-e2e CI gate | ✓ | ✓ | ✓ | ✓ | n/a |
| Design-pack families | 4 (mantine/shadcn/mui/chakra) | 2 (vuetify/shadcnVue) | 2 (shadcnSvelte/flowbite) | 3 (angularMaterial/primeng/spartanNg) | 1 (ashPhoenix) |

**The standing frontend debt:**

1. **Pack breadth is uneven** (LOW, not a correctness bug) — React has 4 pack
   families / 8 versions; Vue and Svelte have 2 each; Angular has 3
   (`angularMaterial`, `primeng`, `spartanNg` — the latter two **shipped**, no
   longer grammar-reserved). Within a frontend every pack is systems-equivalent;
   they diverge only in design-system identity. ([design-packs](../../design-packs.md).)
2. **`store` persist/sync ladder** — the `store` primitive is v1 in-memory on all
   five targets; `persist:`/`sync:` parse but stay validator-gated
   (`loom.store-lifetime-unsupported`), and cross-store calls are gated on
   LiveView only (`loom.store-cross-store-on-liveview-unsupported`).

## Adapter sub-matrix

Within a backend, persistence is pluggable. The minimal-v1 adapters reject a
slice of model features (fail-fast, `loom.<adapter>-unsupported`):

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
- **`marten` (dotnet)**, **`style: cqrs` (node)**, **`style: layered` (dotnet)**
  are reserved stubs. See [platform-realization-axes](./platform-realization-axes.md).

The drizzle (node) and EF Core (dotnet) full-surface adapters are the reference;
node's `auditable` stamping moved into the persistence layer on **both** adapters
(#1554 drizzle, #1565 mikroorm — `db/audit-stamp.ts` reads the ambient
`requestContext().actorId`, dropping the operation-time `_stampOn` methods).

## Reserved-but-unwired cross-cutting hooks

`PlatformSurface` declares five optional lifecycle hooks, **undefined on every
backend today** — designed boundaries with no implementation:
`emitAuthGate` ([authorization](./authorization.md)),
`emitAuditInit` ([audit-and-logging](./audit-and-logging.md)),
`emitCompliancePolicy` ([sensitivity-and-compliance](./sensitivity-and-compliance.md)),
`emitTenancyFilter` ([multi-tenancy-design-note](./multi-tenancy-design-note.md)),
`emitI18nAdapter` ([i18n](./i18n.md)).

## Suggested prioritisation

Ordered by blast radius — how many real models the gap blocks today:

1. **`shape(document)` filters** — wire the in-app filtering path on python (and,
   if ever needed, elixir) so a `document` aggregate can carry a capability
   `filter`; node/java already do. The narrowest remaining filter gap now that
   relational + embedded are done. ([multi-tenancy-design-note](./multi-tenancy-design-note.md).)
2. **Frontend pack breadth** — ship more Vue/Svelte pack families to match
   React's depth; not a correctness item. ([design-packs](../../design-packs.md).)
3. **Alternate adapters** — promote `dapper`/`mikroorm` past minimal-v1, or
   formally freeze their scope; implement or remove the `marten`/`cqrs`/`layered`
   stubs. ([platform-realization-axes](./platform-realization-axes.md).)

The hard rule the gates already enforce: an unsupported combination must **fail
fast at validate time** (with a `loom.*-unsupported` code), never silently
downgrade. The `test/platform/backend-parity-gates.test.ts` guardrail (#1493)
mechanically forbids the silent-gap footgun — every (capability × backend) must
be GATED or REALISED, never neither. Any new parity work inherits that contract.
