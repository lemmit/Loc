# Stdlib plan — table-driven intrinsics + a self-hosted `std/` prelude

Follow-up to [`docs/audits/completeness-audit-2026-07.md`](../audits/completeness-audit-2026-07.md),
which identified the near-empty computation stdlib as the single largest expressiveness
gap (strings: `.length`/`.matches` only; math: bare operators; dates: `now()` +
comparison; collections: a closed set of 8 ops).

## The architecture decision

Two layers, split by an invariant Loom cannot escape:

**Loom expressions have dual semantics.** The same expression must render both as
in-memory host code (operation bodies, invariants, derived props) *and* as a queryable
predicate (find `where`, views, criteria, capability filters — the
`firstNonQueryableNode` machinery). A stdlib function implemented *in Loom* as a block
body can never push down to SQL. Therefore:

- **Layer 0 — intrinsics** live in the compiler, per-backend. Irreducible (you cannot
  write `trim` without character operations) and required for query pushdown. The fix
  here is not moving them out of the compiler but making them **data instead of code**:
  today one new op touches `type-system.ts`, `lower-expr.ts`, and five `render-expr.ts`
  files; after this plan it is one registry row.
- **Layer 1 — the `std/` prelude** is written in `.ddd` on top of Layer 0, using
  **expression-form functions**, which are already SQL-inlinable by design
  (`ddd.langium` `FunctionDecl`: "`= Expression` — SQL-inlinable like a `criterion`").
  Inlining at lowering time means backends and the query path see only Layer-0 ops —
  zero per-backend work per stdlib function, and the stdlib is testable with Loom's own
  `test` blocks across all five backends.

The missing language feature that makes Layer 1 possible is small: a **top-level,
importable `function`** (today `function` exists only as an aggregate/VO/entity member,
and `domainService` operations only as context members).

A sixth backend after this plan implements ~40 intrinsic leaves and inherits the entire
Layer-1 stdlib for free.

---

## Phase A — the intrinsic registry (Layer 0)

### A1 — registry infrastructure + pilot op (`trim`)

Extend the `src/util/collection-ops.ts` pattern into a full catalogue,
`src/util/intrinsics.ts` (pure data, importable from every layer without back-edges):

```ts
export interface IntrinsicSignature {
  receiver: "string" | "int" | "long" | "decimal" | "money" | "datetime" | "collection" | "none";
  name: string;                       // "trim"
  params: IntrinsicParamType[];       // [] | ["string"] | ["int", "int?"] | ["lambda"]
  returns: IntrinsicReturn;           // "string" | "int" | … | "element" | "sameCollection"
  queryable: boolean;                 // may appear left of firstNonQueryableNode
}
```

Wiring (one-time; after this, ops are rows):

- `type-system.ts` — `membersOfType` / member typing reads the catalogue instead of the
  hardcoded `length`/`matches`/collection-op arms (completion items come free).
- `lower-expr.ts` — lower to the existing `method-call` ExprIR with a
  `callKind: "intrinsic"` (or reuse the current method-call path + catalogue membership,
  whichever keeps `loom-ir.ts` unchanged — decide in-slice; prefer no new `ExprIR.kind`).
- `_expr/target.ts` — one new leaf method `intrinsic(e, recv, args)` on `ExprTarget`;
  each backend's table is a `Record<string, (recv, args) => string>` — a *snippet map*,
  not code paths. Unknown key = compile error via an exhaustiveness test that pins every
  catalogue row against every backend map (the `walker-stdlib-completeness` pattern).
- Queryable path: each backend's find-predicate renderer (Drizzle / EF / JPQL /
  SQLAlchemy / Ecto fragment) gets the same snippet-map treatment for `queryable: true`
  rows; `firstNonQueryableNode` consults the catalogue's `queryable` flag.
- Validator: honest gate `loom.intrinsic-not-queryable` when a non-queryable intrinsic
  appears in a `where` position.

Pilot lands `trim` end-to-end on all 5 backends + 5 query paths + walker/Zod wire layer,
with per-backend arm tests. Acceptance: adding the *second* op is a data-only diff.

```ddd
invariant email.trim().length > 0
find byName(q: string): Customer[] where name.trim() == q
```

```ts
// hono, in-memory            // hono, where-position (Drizzle)
this.email.trim().length > 0  sql`trim(${schema.customers.name}) = ${q}`
```

### A2 — string batch

`trim, toUpper, toLower, substring(start, len?), startsWith, endsWith, contains,
replace(find, repl), split(sep) → string[], indexOf → int, padStart/padEnd(n, s)`.
All queryable except `split` (collection-producing; DB-dialect-dependent — mark
non-queryable in v1).

### A3 — math batch

`abs, round(places?), floor, ceil, min(a,b), max(a,b)` on `int/long/decimal/money`
(money keeps closed-arithmetic rules: `round` on money returns money). All queryable.

### A4 — collection batch

`map(λ) → U[]`, `sortBy(λ[, desc])`, `distinct`, `min(λ)/max(λ)/avg(λ)`, `take(n)/skip(n)`,
`join(sep)` (string collections). In-memory on all backends; queryable only where the
existing collection-predicate pushdown already reaches (containment JSONB/child-table
paths) — default `queryable: false`, honest validator gate, revisit per-op.

### A5 — temporal types + arithmetic (the type-system slice)

The one part that is *not* just registry rows — new vocabulary:

- `duration` primitive + constructors `days(n), hours(n), minutes(n), months(n)`
  (calendar-aware vs absolute split follows each backend's native type: `Period`/
  `Duration` on Java, `TimeSpan`/months-special-case on .NET, `timedelta`/
  `relativedelta` on Python, `Timex`-free Ecto interval on Elixir, `date-fns` on TS —
  the per-backend divergence is why this must be Layer 0).
- `arithmeticResult` arms: `datetime ± duration → datetime`, `datetime - datetime →
  duration`, `duration ± duration`, `duration * int`.
- Queryable: `interval` arithmetic exists on Postgres for all five ORMs.
- Optional sub-slice: `date` primitive (calendar date). Defer `time`/timezones — the
  audit's timezone story is a separate proposal.

```ddd
derived isOverdue: bool = now() > dueDate + days(30)
```

```sql
-- where-position, all backends
now() > due_date + interval '30 days'
```

### A6 (optional, independent) — string interpolation

`"Order {id} for {customer.name}"` — grammar + lowering to concat of existing pieces;
no new backend surface (renders through existing `+`/`string()` paths). Can land any
time after A2.

## Phase B — top-level `function` (the Layer-1 enabler)

- **B1 — grammar + scope:** admit `FunctionDecl` as a `ModelMember`/`SystemMember`
  (file top level), exported into global scope like value objects. Purity rules already
  exist (no repo/emit/mutation). `print-structural.ts` arm + completeness test;
  `langium:generate` + committed output.
- **B2 — lowering = inlining:** expression-form top-level functions inline at call sites
  during lowering (the `criterion` mechanism, generalised to value-returning
  expressions), so ExprIR downstream is unchanged — **no backend work at all** and
  queryability falls out. Block-form top-level functions lower like domain-service
  operations (real emitted functions, non-queryable) — or are deferred out of B2 if the
  emission seam is disproportionate; decide in-slice.
- Validator: recursion rejected for expression-form (inlining must terminate) —
  `loom.function-recursive`.

```ddd
function isBlank(s: string): bool = s.trim().length == 0

context Sales {
  aggregate Customer {
    name: string
    invariant !isBlank(name)
  }
}
```

```csharp
// .NET, inlined — no Function class is emitted
if (!(!(Name.Trim().Length > 0))) throw new DomainInvariantException(...);
```

## Phase C — the `std/` prelude in `.ddd`

- **C1 — distribution:** ship `std/*.ddd` inside the toolchain package; resolve
  `import "loom:std/strings"` (a `loom:` scheme arm in the project loader next to the
  file-relative path). Auto-import the prelude set the way `src/macros/prelude.ts`
  registers capabilities, with the same "user declaration wins" shadowing rule.
- **C2 — content:** `std/strings.ddd`, `std/math.ddd`, `std/temporal.ddd` — curated
  expression-form functions composed from Layer 0 (`isBlank`, `initials`, `clamp`,
  `percentOf`, `isOverdue`, `age`, …), each with `test` blocks. Wire the files into the
  behavioral corpus + conformance suite so the stdlib doubles as a permanent
  cross-backend conformance fixture.
- **C3 — docs:** `docs/stdlib.md` reference (intrinsics table generated from the
  registry — single source of truth), language.md cross-links.

## Sequencing & gates

A1 → A2/A3 (parallel) → A4; A5 independent after A1; A6 anytime after A2.
B1→B2 independent of Phase A (but Layer 1 is only *useful* once A2+A3 exist).
C after A2/A3 + B2.

Every Phase A slice: `npm test` + per-backend arm tests + the catalogue-completeness
pin + at least one heavy compile gate per touched backend (`LOOM_TS_BUILD`, dotnet
container build, gradle, uv/mypy, `LOOM_HEX_MIRROR=1` mix). Phase B: parsing +
negative-validator + print-roundtrip + one generator test per backend. Phase C:
behavioral corpus green.

## Explicitly out of scope

- User-supplied per-backend intrinsic snippets (an `extern`-style pressure valve for
  Layer 0) — parity/queryability risk; revisit only if `std/` demand shows a pattern.
- Timezones, business-day calendars (need their own proposal).
- Higher-order user functions / generics (audit Tier 2; unchanged by this plan).
