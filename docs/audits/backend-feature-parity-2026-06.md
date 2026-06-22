# Backend Feature-Parity Audit

**Snapshot date:** 2026-06-21

> **[2026-06-22 refresh, code-verified against `main` @ `cf77fcf`]** Since the
> original snapshot a wave of plan workstreams landed. Changes folded in below:
> **provenance now ships on Java + Python** (#1490/W2 — `PROVENANCE_BACKENDS` is
> `{node, dotnet, java, python}`), so **F2 is largely resolved**; a new
> **`ignoring <Cap>` filter-bypass** feature landed (#1501) and is added to the
> matrix; the **F1 parity guardrail meta-test** (#1493/W5,
> `test/platform/backend-parity-gates.test.ts`) now mechanically forbids the
> silent-gap footgun; **Phoenix foundation routing** was formalized as a contract
> (#1496/W4); and the cited gate line numbers were re-synced (they had all
> shifted). Per-operation `audited` on Java/Python (W3a) is **in flight** (#1503),
> not yet on `main` — `AUDIT_OP_BACKENDS` is still `{node, dotnet}`.

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
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | `EVENT_SOURCING_BACKENDS` · system-checks.ts:1849 |
| Event-sourced **workflow** (saga appliers) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `EVENT_SOURCING_WORKFLOW_BACKENDS` · system-checks.ts:1950 |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `TPH_CAPABLE` · system-checks.ts:1798 |
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
| `ignoring <Cap>` filter-bypass | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | `FILTER_BYPASS_FAMILIES` / `bypassSupported` · system-checks.ts:1148 |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | `PROVENANCE_BACKENDS` · system-checks.ts:1999 |
| Per-operation `audited` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | `AUDIT_OP_BACKENDS` · system-checks.ts:2055 |
| Audited **lifecycle** (`audited create`/`destroy`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | `AUDIT_LIFECYCLE_BACKENDS` · system-checks.ts:2056 |
| Audit/context stamping (`with audit` → `contextStamps`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | not gated (all reference it; runtime depth varies — see §6) |
| Ordered `X id[]` reference collections | ✓ | ✓ | ✓ | ✓ | ✗ set | ✗ set | set semantics (see §7) |

The reference platforms (node/dotnet/react) are now the **trailing** view: the
big movements since the 2026-06-03 inventory are (1) **TPH is no longer node-only
— all five backends emit it**, (2) **Java and Python reached full backend status**
(unions, carriers, `when`, returns, ES, all three saving shapes), (3) the
**Phoenix `vanilla` foundation** unlocked ES + document + provenance that the Ash
foundation still gates, and (4) **provenance landed on Java + Python** (#1490),
leaving per-operation `audited` as the last cross-cutting gap on those two (W3a,
in flight — #1503).

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

### F2 — Audit runtime is the last cross-cutting gap (provenance now closed on Java/Python)

> **[2026-06-22] Largely resolved.** Provenance shipped on Java + Python (#1490/W2):
> `PROVENANCE_BACKENDS = {node, dotnet, java, python}` (system-checks.ts:1999), plus
> elixir·vanilla via the foundation predicate (`provenanceSupported` →
> `foundation === "vanilla"`, system-checks.ts:1158). The original "Java/Python emit
> no provenance" claim is no longer true.

What remains: `AUDIT_OP_BACKENDS = {node, dotnet}` (system-checks.ts:2055) and
`AUDIT_LIFECYCLE_BACKENDS = {node}` (system-checks.ts:2056). Java and Python still
gate per-operation `audited` (fail-fast, good) — closing that is **W3a, in flight**
(#1503). Lifecycle `audited` (`audited create`/`destroy`) is node-only and is a
grammar/feature gap, not a port (no other backend emits it). So the
cross-cutting/compliance gap has narrowed from "provenance + audit on two backends"
to "per-op audit on two backends, with the PR open."

### F3 — Elixir foundation split is the dominant elixir story

Three features are gated on `elixir·ash` but ship on `elixir·vanilla`:
event-sourced **aggregate** storage, `shape(document)`, and provenanced fields.
Event-sourced **workflows** (saga appliers) are gated on **both** elixir
foundations (`EVENT_SOURCING_WORKFLOW_BACKENDS` omits elixir entirely) — the
saga emitters key off `correlationField` and would misgenerate a state-based
saga. Exception-less returns are per-op on ash (return-dominant actions only;
mutate-then-return / guarded bodies defer to vanilla).

> **[2026-06-22]** This split is now a *documented contract*, not loose debt:
> #1496/W4 formalized Phoenix foundation routing (see `docs/platforms.md`) — a
> feature ash can't idiomatically emit is reached by routing the deployable to
> `vanilla`, which is the intended end state, not a gap to close on ash.

### F4 — Documentation drift *(resolved)*

> **[2026-06-22] Both items resolved.** `gated-features-inventory.md` now carries a
> "Superseded (2026-06-21)" banner pointing here. `docs/generators.md` now uses the
> three reference platforms (TS/.NET/React) for matrix readability **with an explicit
> note that each row maps to Python/FastAPI, Java/Spring Boot, and Elixir/Phoenix**
> (generators.md:35-37) — a deliberate readability choice, not a deferral, so a full
> column-per-backend rewrite is no longer warranted.

Original concern: the generators.md matrix only broke out TS/.NET/React with the
other backends deferred to prose, and the stale `gated-features-inventory.md` had no
superseded marker.

---

## Per-feature detail

### 1. Persistence & storage

- **Event-sourced storage** — `EVENT_SOURCING_BACKENDS = {node, dotnet, python,
  java}` (system-checks.ts:1849). Elixir is foundation-shaped: `vanilla` emits the
  `<agg>_events` stream + fold (`elixir/vanilla/eventsourced-emit.ts`), `ash` is
  gated (`loom.event-sourcing-backend-unsupported`) — no pure-ES Ash fit.
- **Saving shapes** — `PLATFORM_SAVING_SHAPES` (platform-axes.ts:40): node/dotnet/
  java/python all carry `[relational, embedded, document]`; elixir base set is
  `[relational, embedded]`, with `document` un-gated only on `vanilla`
  (`elixir/vanilla/document-emit.ts`, DEBT-07).
- **Inheritance** — TPC (`ownTable`) universal. TPH (`sharedTable`, the
  omitted-modifier default) is now `TPH_CAPABLE = {node, dotnet, elixir, python,
  java}` (system-checks.ts:1798) — **the headline change from the prior audit,
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

**`ignoring <Cap>` filter-bypass** (#1501): a read may carry an `ignoring *` /
`ignoring <Cap>` clause that drops a specific capability filter from that read.
`FILTER_BYPASS_FAMILIES = {dotnet, node}` (system-checks.ts:1148) honor it on every
foundation (EF `IgnoreQueryFilters`; Drizzle omits the bypassed conjunct);
elixir·`vanilla` honors it (Ecto omits the bypassed `where:`) but elixir·`ash`,
`java`, and `python` are **deferred** — `bypassSupported` keeps them fail-fast
(`loom.filter-bypass-*`), never silently still-filtering.

### 5. Provenance & audit

`PROVENANCE_BACKENDS = {node, dotnet, java, python}` (system-checks.ts:1999) +
elixir·vanilla via the foundation predicate (`foundation === "vanilla"`,
system-checks.ts:1158). `AUDIT_OP_BACKENDS = {node, dotnet}` (system-checks.ts:2055);
`AUDIT_LIFECYCLE_BACKENDS = {node}` (system-checks.ts:2056). Java and Python now
**emit provenance** (#1490/W2) but still gate per-operation `audited` (W3a in flight,
#1503). See **F2**.

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
  and `src/util/platform-axes.ts` — originally on `main` @ `9a5949b`, re-verified and
  line-synced @ `cf77fcf` (2026-06-22).
- A live guardrail now backs this audit: `test/platform/backend-parity-gates.test.ts`
  (#1493/W5) asserts that every (capability feature × backend) is either GATED (a
  `loom.*` error) or REALISED (an emitter marker) — "neither" (the F1 silent gap)
  fails the test. The gate sets above can no longer drift into a silent hole without
  CI catching it.
- "🔴 silent gap" is reserved for a backend that is *absent from a gate's checked
  set AND emits nothing*. F1 was such a gap at the original snapshot; #1481 (W1a)
  resolved it — python is now in `LIMITED_FAMILIES` and `grep -rn contextFilters
  src/generator/python/` hits `find-predicate.ts` (the non-principal case is emitted).
- This is a point-in-time empirical snapshot. `main` moves fast; re-derive from the
  cited lines before treating any row as current.
