# Backend Feature-Parity Audit

**Snapshot date:** 2026-06-21

A cross-backend audit of the *generated-backend* feature surface — which
language features each backend actually emits, where the parity gates live, and
where a feature is **silently** unsupported (emits nothing without a validator
error). This supersedes [`gated-features-inventory.md`](gated-features-inventory.md)
(2026-06-03), which predates Java/Python being broken out as backends and the
Phoenix `vanilla` foundation gaining event-sourcing / document support.

The **authoritative source** for every row is the cited validator gate set in
`src/ir/validate/checks/` (and `src/util/platform-axes.ts`). The validator is
the contract: a feature a backend can't emit is a hard error there (fail-fast,
never a silent downgrade) — *except* where a backend is omitted from a gate's
checked set, which produces a silent gap (see Finding F1). When this doc and the
code disagree, the code wins.

Backends audited (the five domain-logic backends):

| Family | Platform id | Stack |
|---|---|---|
| Hono / TS | `node` | Hono + Drizzle |
| .NET | `dotnet` | ASP.NET + EF Core + Mediator |
| Java | `java` | Spring Boot + JPA |
| Python | `python` | FastAPI + SQLAlchemy 2 |
| Phoenix | `elixir` | LiveView + Ash **or** vanilla Ecto |

Elixir is split into its two **foundations** (`ash` default / `vanilla`) wherever
the gap is foundation-shaped, not platform-shaped.

Legend: ✓ implemented · ✗ gated (validator error) · ⚠ partial · 🔴 **silent gap**
(no emit, no gate) · N/A not applicable.

---

## Summary matrix

| Feature | node | dotnet | java | python | elixir·ash | elixir·vanilla | Gate (source of truth) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | `EVENT_SOURCING_BACKENDS` · system-checks.ts:1664 |
| Event-sourced **workflow** (saga appliers) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `EVENT_SOURCING_WORKFLOW_BACKENDS` · system-checks.ts:1765 |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `TPH_CAPABLE` · system-checks.ts:1613 |
| TPC inheritance `inheritanceUsing(ownTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | (universal) |
| `shape(document)` persistence | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | `PLATFORM_SAVING_SHAPES` · platform-axes.ts:40 |
| `shape(embedded)` persistence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `PLATFORM_SAVING_SHAPES` · platform-axes.ts:40 |
| Discriminated unions (`A or B` / `payload = A\|B` / `T option`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_UNION_BACKENDS` · structural-checks.ts:414 |
| Generic carriers (`paged<T>`, `envelope<T>`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_PAGED_BACKENDS` · structural-checks.ts:232 |
| `when` canCommand gate + `can_<op>` query | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `SUPPORTED_WHEN_BACKENDS` · structural-checks.ts:484 |
| Exception-less returns (`op(): X or NotFound`) | ✓ | ✓ | ✓ | ✓ | ⚠ return-dominant only | ✓ | `SUPPORTED_RETURN_BACKENDS` · structural-checks.ts:518 |
| Non-principal capability `filter` (relational) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `LIMITED_FAMILIES` · system-checks.ts:1004 |
| Principal capability `filter` (`currentUser`/tenancy, relational) | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | `supportsPrincipalFilter` · system-checks.ts:1021 |
| Capability `filter` on non-relational shape (doc/embedded) | ✓ | ✓ | ✓ | ✗ | ⚠ embedded only | ⚠ embedded only | `supportsNonRelationalFilter` · system-checks.ts:1044 |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | `PROVENANCE_BACKENDS` · system-checks.ts:1814 |
| Per-operation `audited` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | `AUDIT_OP_BACKENDS` · system-checks.ts:1870 |
| Audited **lifecycle** (`audited create`/`destroy`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | `AUDIT_LIFECYCLE_BACKENDS` · system-checks.ts:1871 |
| Audit/context stamping (`with audit` → `contextStamps`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | not gated (all reference it; runtime depth varies — see §6) |
| Ordered `X id[]` reference collections | ✓ | ✓ | ✓ | ✓ | ✗ set | ✗ set | set semantics (see §7) |

The reference platforms (node/dotnet/react) are now the **trailing** view: the
big movements since the 2026-06-03 inventory are (1) **TPH is no longer node-only
— all five backends emit it**, (2) **Java and Python reached full backend status**
(unions, carriers, `when`, returns, ES, all three saving shapes), and (3) the
**Phoenix `vanilla` foundation** unlocked ES + document + provenance that the Ash
foundation still gates.

---

## Findings

### F1 — ✅ RESOLVED (#1481/W1a) — Python capability `filter` is now gated AND the non-principal case is emitted

> **[2026-06-21 audit refresh, code-verified against #1496]** This finding,
> filed as a 🔴 silent gap, is now **resolved** on `main`. The original text
> follows for history.

On `main` today, `validateContextFilterSupport` reads
`LIMITED_FAMILIES = new Set(["node", "elixir", "java", "python"])`
(`system-checks.ts:1004`, wired at `validate.ts`). **`python` is now in the set**,
so the validator no longer treats it as fully capable. The split is precise:

- **Non-principal relational filters (W1a)** — `python` now **emits** them.
  `contextFilterPredicate` in `src/generator/python/find-predicate.ts` lowers an
  aggregate's non-principal capability filters to a SQLAlchemy predicate and
  `repository-builder.ts` AND-s it into every root read (the SQLAlchemy analogue of
  EF's `HasQueryFilter`). The grep that flagged the gap now hits:
  `grep -rn contextFilters src/generator/python/` returns
  `find-predicate.ts` (no longer zero matches).
- **Principal filters (W1b — `currentUser`/tenancy)** — still **gated** on python.
  `supportsPrincipalFilter` (`system-checks.ts:1021`) returns true only for
  node/elixir/java; python falls through to `false`, so a principal-referencing
  filter on a python aggregate is a hard `loom.*` error, not a silent no-op.
- **Non-relational-shape filters (doc/embedded)** — still **gated** on python.
  `supportsNonRelationalFilter` (`system-checks.ts:1044`) admits node (doc+embedded),
  java (doc+embedded), elixir (embedded) — python is absent, so it errors.

**Net:** the correctness hole the original finding described (a python aggregate's
reads with no WHERE scoping) is closed — the only un-emitted cases (principal,
non-relational) now fail fast at validation rather than silently emitting an
unscoped backend. python is no longer a 🔴; it's ✓ for the non-principal relational
case and ✗ (honest gate) for the rest.

<details><summary>Original finding (pre-#1481, superseded)</summary>

The capability-filter gate `validateContextFilterSupport`
(`system-checks.ts:1006`, wired at `validate.ts:118`) only inspects families in
`LIMITED_FAMILIES = {node, elixir, java}` (`:1014`). **`python` is absent**, so
the validator treats it as fully capable — yet the Python generator never
consumes `contextFilters`:

```
$ grep -rn contextFilters src/generator/python/   →  (no matches)
```

Every other backend references it (node `repository-find-predicate.ts`, dotnet
`efcore.ts`, java `entity.ts`/`repository.ts`/`criteria.ts`). The lowering
populates `AggregateIR.contextFilters` (`lower.ts:1210`) regardless of platform.

**Impact:** a `with softDelete` / tenancy `filter !this.isDeleted` /
`filter tenantId == currentUser.tenant` on a **python-hosted** aggregate passes
validation and emits a backend whose reads have **no WHERE scoping** — soft-deleted
rows are returned, and tenancy isolation is silently absent.

**Recommended fix (low-risk, fail-fast):** add `python` to `LIMITED_FAMILIES`.
(The principled fix is to emit the predicate into the SQLAlchemy reads.)

</details>

### F2 — Provenance / audit are the widest real parity gap

`PROVENANCE_BACKENDS = {node, dotnet}` (+ elixir·vanilla); `AUDIT_OP_BACKENDS =
{node, dotnet}`; `AUDIT_LIFECYCLE_BACKENDS = {node}`. **Java and Python emit no
provenance or audited-operation runtime** — both fail fast (good), but it means a
domain that leans on `provenanced`/`audited` can only target node/dotnet (and
elixir·vanilla for provenance). These are the two backends still materially behind
on the cross-cutting/compliance surface.

### F3 — Elixir foundation split is the dominant elixir story

Three features are gated on `elixir·ash` but ship on `elixir·vanilla`:
event-sourced **aggregate** storage, `shape(document)`, and provenanced fields.
Event-sourced **workflows** (saga appliers) are gated on **both** elixir
foundations (`EVENT_SOURCING_WORKFLOW_BACKENDS` omits elixir entirely) — the
saga emitters key off `correlationField` and would misgenerate a state-based
saga. Exception-less returns are per-op on ash (return-dominant actions only;
mutate-then-return / guarded bodies defer to vanilla).

### F4 — Documentation drift

`docs/generators.md`'s top-level matrix still only breaks out **TS / .NET /
React** and carries a scope note deferring Java/Python/Elixir/Vue/Svelte/Angular
to prose. Given those backends now pass the same gate sets, the matrix is due a
five-backend rewrite. The stale `gated-features-inventory.md` (node/dotnet/phoenix/
react only) should be marked superseded by this audit.

---

## Per-feature detail

### 1. Persistence & storage

- **Event-sourced storage** — `EVENT_SOURCING_BACKENDS = {node, dotnet, python,
  java}` (system-checks.ts:1664). Elixir is foundation-shaped: `vanilla` emits the
  `<agg>_events` stream + fold (`elixir/vanilla/eventsourced-emit.ts`), `ash` is
  gated (`loom.event-sourcing-backend-unsupported`) — no pure-ES Ash fit.
- **Saving shapes** — `PLATFORM_SAVING_SHAPES` (platform-axes.ts:40): node/dotnet/
  java/python all carry `[relational, embedded, document]`; elixir base set is
  `[relational, embedded]`, with `document` un-gated only on `vanilla`
  (`elixir/vanilla/document-emit.ts`, DEBT-07).
- **Inheritance** — TPC (`ownTable`) universal. TPH (`sharedTable`, the
  omitted-modifier default) is now `TPH_CAPABLE = {node, dotnet, elixir, python,
  java}` (system-checks.ts:1613) — **the headline change from the prior audit,
  which had it node-only.** Mixed-strategy override and polymorphic `Base id` → TPC
  base stay rejected everywhere (language/validators/inheritance.ts).

### 2. Query / payload surface (all five backends ✓)

Discriminated unions, generic carriers (`paged`/`envelope`), and the `when`
canCommand gate are uniform across node/dotnet/java/python/elixir
(structural-checks.ts:414/232/484). The `when` gate's check is now latent (all
five emit it) and stands as a safety net for any future backend.

### 3. Exception-less returns

`SUPPORTED_RETURN_BACKENDS = {node, dotnet, python, java}` (structural-checks.ts:
518). Elixir is per-op (structural-checks.ts:525): `vanilla` handles every
returning op; `ash` handles return-dominant ops (a generic action) plus in-memory
mutation + `precondition`/`requires` guards — `emit`/`add`/`remove` bodies still
defer to vanilla (DEBT-03).

### 4. Capability filters

`LIMITED_FAMILIES = {node, elixir, java, python}` (system-checks.ts:1004). Principal
(`currentUser`) filters on relational aggregates are wired on node, elixir (both
foundations), java, and dotnet (EF `HasQueryFilter`, ungated). Non-relational-shape
filters: node + java (document + embedded), elixir (embedded only); principal +
non-relational stays gated everywhere. **dotnet** is ungated because it genuinely
supports the full surface; **python** now emits the non-principal relational case
(W1a — `contextFilterPredicate` in `find-predicate.ts`, AND-ed into every root read)
and gates principal (W1b) + non-relational filters — see **F1** (resolved #1481).

### 5. Provenance & audit

`PROVENANCE_BACKENDS = {node, dotnet}` + elixir·vanilla (system-checks.ts:1814).
`AUDIT_OP_BACKENDS = {node, dotnet}`; `AUDIT_LIFECYCLE_BACKENDS = {node}`
(system-checks.ts:1870-71). Java and Python gate all three. See **F2**.

### 6. Audit / context stamping (`contextStamps`)

Not gated — co-hosting is allowed. All five backend generators now reference
`contextStamps` (dotnet 7 files, java/python/elixir 2 each, node via a shared
helper), where the 2026-06-03 inventory recorded runtime parity as node-only with
dotnet/phoenix "parsed, parity deferred." The breadth has grown; full *runtime*
equivalence (e.g. principal-referencing stamp values, lifecycle hooks) still
varies per backend and is worth a dedicated runtime conformance pass rather than a
static-reference count.

### 7. `X id[]` reference-collection ordering

Unchanged: node (Drizzle) / dotnet (EF) / java (JPA `@ElementCollection` / join)
/ python write an `ordinal` and `ORDER BY ordinal`; elixir (Ash) leaves the
ordinal at default and returns Postgres order. The **wire contract is unordered
(set semantics)** — `party[0]` means "some element," not "the first." Documented
in `generators.md` → "What the generators don't do."

---

## Method notes

- Gate sets were read directly from `src/ir/validate/checks/{system,structural}-checks.ts`
  and `src/util/platform-axes.ts` on `main` @ `9a5949b`.
- "🔴 silent gap" is reserved for a backend that is *absent from a gate's checked
  set AND emits nothing*. F1 was such a gap at the original snapshot; on #1496 it is
  resolved — python is now in `LIMITED_FAMILIES` and `grep -rn contextFilters
  src/generator/python/` hits `find-predicate.ts` (the non-principal case is emitted).
- This is a point-in-time empirical snapshot. `main` moves fast; re-derive from the
  cited lines before treating any row as current.
</content>
</invoke>
