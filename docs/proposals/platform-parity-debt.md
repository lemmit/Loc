# Platform parity debt — the cross-backend gate inventory

> **Status:** SUMMARY / debt register — no new surface; tracks existing gates.
> **Role:** A single roll-up of every feature that works on some backends but
> not others (node/Hono, dotnet/.NET, phoenix/LiveView, react). It exists so the
> parity gaps that are otherwise scattered across per-feature proposals and
> validator codes have one home to prioritise against. Each row links to the
> proposal that owns the fix.
> **Authoritative detail:** the code-verified, file-and-line snapshot lives in
> [`../audits/gated-features-inventory.md`](../audits/gated-features-inventory.md).
> When this précis and that audit disagree, the audit (and the cited code) wins.

Legend: ✓ implemented · ✗ gated (fail-fast validator error) · ⚠ partial / stub · N/A.

## The matrix at a glance

> **[2026-06-20 audit]** Two cells flipped since the last revision: **principal
> `filter`** now ships on node + phoenix (✗→✓; DEBT-01, #1386 — relational shapes;
> principal-on-non-relational stays gated) and **provenanced fields** now ship on
> dotnet (✗→✓) and phoenix-vanilla (#1400 / DEBT-06; ash stays gated). Also note
> this matrix predates the **java / python** backends and the **vue / svelte /
> angular** frontends — those columns are not yet represented here; consult the
> per-feature validator gates (`system-checks.ts`, `src/util/platform-axes.ts`)
> for those five targets until the matrix is widened.

| Feature | node | dotnet | phoenix | react | Owning proposal |
|---|:---:|:---:|:---:|:---:|---|
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✓ vanilla / ✗ ash | N/A | [workflow-and-applier](./workflow-and-applier.md) |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✓ | ✓ | N/A | [aggregate-inheritance](./aggregate-inheritance.md) |
| `shape(document)` persistence | ✓ | ✓ | ✗ | N/A | [document-and-json-hierarchies](./document-and-json-hierarchies.md) |
| Principal `filter` (`currentUser`/tenancy) | ✓ | ✓ | ✓ | N/A | [multi-tenancy-design-note](./multi-tenancy-design-note.md) |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✓ vanilla / ✗ ash | N/A | [provenance](./provenance.md) |
| Generic carriers (`paged<T>`) | ✓ | ✓ | ✓ | ✓ (#898) | [payload-transport-layer](./payload-transport-layer.md) |
| Ordered `X id[]` collections | ✓ | ✓ | ✗ | display | [load-specifications](./load-specifications.md) |
| Per-op `audited` flag | ✓ | ✗ gated | ✗ gated | N/A | [audit-and-logging](./audit-and-logging.md) |
| Audit stamping (`with audit`) | ✓ | ⚠ | ⚠ | N/A | [audit-and-logging](./audit-and-logging.md) |
| Non-constructible aggregates | ✓ | ✓ | ⚠ | ⚠ | [lifecycle-operations](./lifecycle-operations.md) |
| React `where`/list-page filter | — | — | — | ⚠ | [retrieval](./retrieval.md) |
| Page `requires <pred>` (Phoenix) | N/A | N/A | ✓ (guard enforced in `handle_params/3`, `liveview-emit.ts`) | N/A | [frontend-acl](./frontend-acl.md) |

Adapter sub-matrix: `dapper` (dotnet) and `mikroorm` (node) are minimal-v1 and
reject ~11 model features each; `marten` (dotnet), `style: cqrs` (node), and
`style: layered` (dotnet) are reserved stubs. See
[platform-realization-axes](./platform-realization-axes.md).

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

1. **Phoenix backend depth** — `shape(document)`, ordered `X id[]`. Phoenix is the
   backend furthest from parity. (TPH now closed — shared-table multi-resource +
   `base_filter`, see [phoenix-tph-emission](./phoenix-tph-emission.md). Event
   sourcing now closed on the **vanilla** foundation — #1205, D-VANILLA-ES-HOME;
   only `foundation: ash` still rejects `persistedAs(eventLog)`. **Principal
   `filter`s now ship on phoenix** too — DEBT-01, #1386 — so that's off this list.)
2. ✅ **Provenance now IMPLEMENTED** (2026-06-20 audit) — node + dotnet +
   elixir-vanilla emit the real lineage runtime (#1400 / DEBT-06; ash stays gated),
   no longer "gated no-op, remaining work". The residue here is the per-operation
   **`audited`** runtime (still `loom.audited-backend-unsupported` on dotnet/phoenix)
   and `with audit` stamping parity.
3. **React generative gaps** — generic carriers, list-page filters, non-
   constructible create surface; each is a localised walker/emitter addition.
4. **Alternate adapters** — promote `dapper`/`mikroorm` past minimal-v1, or
   formally freeze their scope; implement or remove the `marten`/`cqrs`/
   `layered` stubs.

The hard rule the gates already enforce: an unsupported combination must **fail
fast at validate time** (with a `loom.*-unsupported` code), never silently
downgrade. Any new parity work inherits that contract.
