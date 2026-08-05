# M-T1.3 — Charts & the dashboard ceiling — scoping pass

> **Status:** scope only — nothing implemented. Written 2026-07-29, revised
> 2026-07-30 after a maintainer steer, against fresh `main` (`7938c9b`). Every
> claim below was produced by *generating and compiling output*, not by reading
> the tracker.
>
> **Headline finding:** charts are not a rendering problem first. Four defects
> sit under the ask (§2); three are `tsc`-provable build breaks and one emits
> `undefined.X` into a React page. **Today there is no path from a server-computed
> number to a page at all.** A `Chart` primitive dropped on top of that would
> render a wrong number prettily.
>
> **Maintainer steer (2026-07-30):** no `Dashboard` container primitive. The
> shape is a **`scaffoldDashboard` macro plus a scaffolded projection** that
> computes the numbers server-side; graphs then need genuinely new primitives.
> §3 is planned to that shape, and it is the better decomposition — see §3.0 for
> what it *removes* from the earlier draft.

---

## 1. Where the ask comes from

Three documents converge, and none of them is the chart proposal one remembers —
the vision is spread across them:

| Source | What it says |
|---|---|
| [`T1-ui-frontend.md`](../T1-ui-frontend.md) **M-T1.3** | The whole mission, until this pass, was one line: *"A minimal `Chart` primitive (line/bar over a collection expr). Keep the set closed and small; HEEx renderer required or pinned."* |
| [`completeness-audit-2026-07.md`](../../audits/completeness-audit-2026-07.md) Tier 2 → Frontend | *"**No charts/dashboards** beyond the two-line `Stat` card — no time series, no KPI trend, no drill-down. **(Pairs with the missing aggregation queries.)**"* — the parenthetical is the entire scoping problem. |
| [`read-path-architecture.md`](../../old/proposals/read-path-architecture.md) rev. 8 | Designs the data half and names the use case verbatim: keying is *"a second orthogonal axis — keyed collection vs unkeyed **singleton** (a whole-table read model: **dashboard total / running count**, which `projection.md` deferred)"*. Query-time singletons *"need **aggregation binds** (`count`/`sum`) — a real add `view` lacked."* Group-by is explicitly reserved. |

A fourth, quieter source: the
[extern-component escape hatch](../../old/proposals/extern-component-escape-hatch.md)
uses a **chart** as its motivating example throughout
(`component PriceChart(series: Order[], height: int) extern from "./widgets/price-chart"`).
That escape hatch **ships** at frontend parity (M-T1.4, `done`) — so a
hand-written chart is possible today. What is missing is a *scaffoldable* one,
and the data to put in it.

## 2. What actually ships today — four defects, all verified by generating

Fixture throughout: one `Order { code, total: money }` aggregate, a React ui, a
Hono backend.

### 2.1 What a "dashboard" is today

- **`Stat(label, value)`** is the *only* KPI primitive
  (`_walker/primitives/display.ts:13`). No pack has a dedicated component — all
  17 render two stacked text elements. It accepts any value expression.
- **`scaffoldHome` has no runtime numbers in it at all**
  (`src/macros/stdlib/scaffold/_body-builders.ts`). The scaffolded "dashboard" is
  a welcome page: a heading, a sentence, and up to two static cards reading
  *"3 aggregates / Manage records of each kind from the sidebar."* Those counts
  are **compile-time counts of declarations**.
- The aggregation vocabulary *is* in the language
  ([`docs/stdlib.md`](../../stdlib.md)): `count`, `sum(λ)`, `avg(λ)`, `min(λ)`,
  `max(λ)`, `where(λ)` — documented there as in-memory and **non-queryable**.

### 2.2 Defect A — collection ops do not survive the JSX walker

```ddd
QueryView { of: Sales.Order.all, data: rows => Stat { "Total orders", rows.count } }
```

`ddd parse` → **0 errors, 0 warnings**. Generated `dash.tsx` →
`{orderAll.data.items.count}`, and the real compiler in the generated project:

```
src/pages/dash.tsx(25,59): error TS2339: Property 'count' does not exist on type
  '{ id: string; code: string; total: Decimal; version: number; display: string; }[]'.
```

`walker-core.ts:1428` emits member access verbatim; there is **no
`isCollectionOp` arm anywhere on the JSX walker path** — `grep isCollectionOp`
returns zero hits across `_walker/`, `react/`, `vue/`, `svelte/`, `angular/`.

| Frontend | `rows.count` becomes | Result |
|---|---|---|
| React / Vue / Svelte / Angular | `rows.count` | **build break** on each one's gate |
| Feliz | `(List.length rows)` | correct — `fs-expr.ts:121` has the leaf table |
| Flutter | `rows.count` | `DART_LEAVES` has no collection-op arm |

The one frontend nobody thinks of first is the only one that gets it right,
because it is the only one whose expression renderer is a real leaf table.

**Why CI never caught it:** no example or corpus fixture uses a collection op in
a page body. `Stat` appears in six `.ddd` files, always with a literal, a state
field, or a lambda param.

**Under the new plan this defect is deprioritized — see §3.0.**

### 2.3 Defect B — a client-side KPI over `.all` is page-scoped

`.all` is `Paged<T>` by default since M-T2.6 (`enrichments.ts:1685`, generated
`pageSize: 20`), so `rows` is at most 20 rows. Had `.count` worked, "Total
orders" would read `20`. The true number is one field away in the envelope the
frontend already parses (`OrderPaged.total`) and **unreachable from the DSL**.

**Prior art, and a prior decision.** `examples/sales-ui.ddd` — a self-described
*"HISTORICAL prototype … does NOT parse with the current Langium grammar"* —
carries a whole `page SalesDashboard` sketch:

```ddd
body: Dashboard(items: [
  Card { "Confirmed orders", Stat { api Sales.Order.all, format: "count" } },
  Card { "EUR/USD",          Stat { api ExchangeRates.usd("EUR"), decimals: 4 } },
  Card { "Customer breakdown", Table { api Sales.Customer.all }, span: 2 }
])
```

Its own header records the outcome: *"`MasterDetail`, **`Dashboard`**, and
`Review` were dropped (compose them from a list + `state {}` + display
primitives)"*. So a composite `Dashboard` container was **already considered and
rejected** — that decision stands (and matches the 2026-07-30 steer). What the
sketch shows is that the missing piece is the *data binding*
(`Stat { api …, format: "count" }`), not a layout container.

### 2.4 Defect C — the singleton aggregating projection silently mis-emits

`read-path-architecture` rev. 8's singleton — the designed answer to Defect B —
**parses and validates clean today**:

```ddd
projection SalesTotals {
  orders: int
  from Order as o
  select orders = count
}
```

→ 0 errors, 0 warnings. Then it emits, in `api/http/query-projections.ts`:

```ts
const SalesTotalsResponse = z.array(SalesTotalsRow)   // ← an ARRAY, for a singleton
…
const rows = await repo.salesTotals();
const projected = rows.map((r) => ({
  orders: count,                                      // ← bare undefined identifier
}));
```

and in `api/db/repositories/order-repository.ts`:

```ts
async salesTotals(): Promise<Order[]> {
  const rootRows = await this.db.select().from(schema.orders);      // ← SELECT *, whole table
  const result = rootRows.map((root) => Order._rehydrate({ … }));   // ← rehydrate every row
  return result;
}
```

Real compiler: `http/query-projections.ts(35,15): error TS2304: Cannot find name 'count'.`

Three things wrong at once: an **unbounded full-table load** (precisely the
scaling failure M-T2.6 just removed from `findAll`), **every row rehydrated into
a domain object** to produce one integer, and a **free identifier** that does not
compile.

This is exactly the silent mis-emit the projection validator's own header claims
is prevented — `projection-checks.ts:185-200` says the query-time surface is
*"HONESTLY REJECTED until a backend ports the emit … rather than silently
mis-emitted by the folded path."* The gate `loom.projection-query-time-unsupported`
does not fire because node/Hono **has** ported the query-time emitter; the
comment at `:198` says the *"groupby / singleton-whole-table-aggregation /
paged-sort refinements land WITH that emit"* — they did not, and no gate was left
behind to say so. The honest-gap discipline held for the backends without the
emitter and leaked on the one that has it.

### 2.5 Defect D — there is no ui→projection read path at all (the load-bearing gap)

This is the one that decides the plan. A page reading the projection above:

```ddd
QueryView { of: Sales.SalesTotals, data: r => Stat { "Total orders", r.orders } }
```

→ **0 errors, 0 warnings**, and generates:

```tsx
{ /* unresolved: Sales */ undefined.SalesTotals.isLoading && ( null ) }
…
<Text fw={700} size="xl">{/* unresolved: Sales */ undefined.SalesTotals.data.orders}</Text>
```

`undefined.SalesTotals` is a runtime `TypeError` *and* a build break, emitted
from a model that validates clean. The cause is structural, not a typo:

- `grep -n "projection" src/ir/lower/lower-ui.ts` → **nothing**. Projections are
  never lowered into a ui read.
- `src/generator/_frontend/api-module.ts` emits **no client** for a projection
  route (its only `projection` hits are imports of the unrelated
  `wire-projection.ts`).
- So projections are backend-only read models: they own an HTTP route
  (`GET /sales_totals`) that **no generated frontend ever calls**.

Every design in §3 needs this path. It is a bigger, more load-bearing gap than
the `Chart` primitive.

### 2.6 What this adds up to

| Layer | State |
|---|---|
| Server-computed aggregate (singleton) | designed rev. 8; surface parses, **mis-emits** (Defect C) |
| Group-by / time series | **not in the grammar at all**; reserved in the proposal, code not present |
| ui reads a projection | **absent** — emits `undefined.X` (Defect D) |
| Aggregation in a page expression | **broken** on 4/6 frontends, correct on Feliz (Defect A) |
| Paged `total` reachable from the DSL | no (Defect B) |
| KPI component | `Stat`, works with any value expression |
| Chart component | none; `extern component` is the escape hatch and it works |

## 3. The plan

### 3.0 What the maintainer steer changes

The earlier draft made **Defect A** (mapping collection ops into the four JSX
frontends) the P1 slice, so a page could compute `rows.count` client-side. The
`scaffoldDashboard` + scaffolded-projection shape **removes that need**: a KPI
card reads a **scalar field off a projection row** (`totals.orders`), never a
collection op over a fetched array. No collection-op lowering, no second
expression dialect in the frontends, and the number is computed by the database
instead of by the browser over one page of rows.

So Defect A drops from P1 to a **cheap honesty gate** (§3.6). The critical path
becomes C → D → the macro.

### 3.1 Phase 0 — make a server-computed number real (Defect C) · **LANDED on all five backends**

Backend-only. No UI, no macro, no chart. Node/Hono first behind the established
honest-gap pattern (`PROJECTION_AGG_SUPPORTED` in `system-checks.ts`), then the
four ports — so `PROJECTION_AGG_SUPPORTED` is now the full set. It is kept, not
deleted: it is the seam a *new* backend gates on until it ports.

| Backend | Push-down | Verified with |
|---|---|---|
| node | drizzle `count()`/`sum(col)` in one `db.select` | `tsc --noEmit` + `tsup` |
| python | `select(func.count(), func.sum(Row.col)).select_from(Row)` | `ruff` + `mypy --strict` |
| dotnet | EF `GroupBy(_ => 1).Select(g => new { … })` — one query, not one per operator | `dotnet build /warnaserror` |
| java | JPQL through the `EntityManager` | `gradle testClasses bootJar` |
| elixir | Ecto `select: %{…count/sum…}` + `Repo.one()` | `mix compile --warnings-as-errors` |

**One detector, five dialects.** `wholeTableAggregates` / `aggregateCoercion`
live in `src/ir/util/projection-aggregate.ts`; each backend supplies only its
SQL spelling and its coercion syntax. Which selects are an aggregation, and
what type each result must land on, are IR facts — five copies would drift.

**Java goes through the `EntityManager`, not a Spring Data method**, because a
multi-aggregate select has no derived-query spelling and a `@Query` on the
aggregate's repository would make the read model edit the aggregate's own port
for a projection it knows nothing about.

**Two bugs the real compilers caught, one per backend family:**
- **.NET** — LINQ `Average` over an `int` returns `double`, so a row field
  declared `decimal` is `CS1503`. The coercion now casts to the DECLARED wire
  type; LINQ picks the aggregate's own result type, which need not be the row's.
- **Python** — a file of only aggregations imported `RootModel` and the source
  repository, both unused (`F401`), because the list-response and repository
  paths were unconditional.

**Elixir needed the money/decimal split**: Jason encodes a bare `%Decimal{}` as
a JSON *string*, which is exactly what `money` wants and exactly what a plain
`decimal` must not be — the other four ship it as a number (RS-24).

```ddd
projection SalesTotals {
  orders: int   revenue: money   avgLines: decimal   biggest: money
  from Order as o
  where Confirmed
  select orders = count, revenue = sum(o.total), avgLines = avg(o.lineCount), biggest = max(o.total)
}
```
```ts
const [row] = await db.select({ orders: count(), revenue: sum(schema.orders.total),
  avgLines: avg(schema.orders.lineCount), biggest: max(schema.orders.total) })
  .from(schema.orders).where(eq(schema.orders.status, "Confirmed"));
const projected = {
  orders: Number(row?.orders ?? 0),
  revenue: String(row?.revenue ?? "0"),
  avgLines: Number(row?.avgLines ?? 0),
  biggest: String(row?.biggest ?? "0"),
};
```

What it took, beyond the obvious:

- **Lowering normalises, emitters consume** (the proposal's own rule). A new
  `select.aggregate` (`{ op, arg? }`) is resolved once in `lower-projection.ts`
  so no backend re-detects an aggregation from a raw expression.
- **Two IR shapes.** `count` lowers to `refKind: "unknown"`, `sum(o.total)` to
  `callKind: "free"`. Covering one leaks the other.
- **The type comes from the operator.** A bare `count` infers as `string`
  through the ordinary expression path — simply wrong. `avg` widens to decimal
  even over an int column.
- **Coercions are load-bearing.** Postgres returns `numeric` aggregates as
  **strings** through the driver, and `NULL` over an empty table. `count` has a
  meaningful zero; `sum` over no rows is SQL `NULL`, and a non-optional declared
  field means zero.
- **A singleton returns the row, not an array of one** — the `z.array` wrapper
  was what made `select orders = count` look like a list of counts.
- **`loom.projection-groupby-unsupported` now exists** (it was a documented
  reservation with no code). Mixing an aggregate with a per-row `select` is a
  GROUP BY — one row per distinct value — so it is reserved rather than guessed
  at. This is Phase 3's surface.
- **A latent `TS1361` on a neighbouring path, found by the real compiler.** The
  file imports `import type * as schema`, so `schema.orders` in value position
  doesn't compile. The **raw-table-source path has the same break** and no
  fixture ever compiled it. Both fixed by a needs-based value import.

Independently valuable: closes a silent mis-emit *and* an unbounded table scan.
**Remaining:** the four non-node backends (each lifts its own gate).

### 3.2 Phase 1 — the ui→projection read path (Defect D) · **LANDED on react**

A page can now read a projection. Singleton-only, react-only, both gated:

```ddd
QueryView {
  of: Sales.SalesTotals,
  data: t => Group { Stat { "Orders", t.orders }, Stat { "Revenue", Money { t.revenue } } }
}
```
```tsx
import { useSalesTotals } from "../api/projections";
const salesTotals = useSalesTotals();
…
{ salesTotals.data && (
  <Group>
    <Stack gap={2}><Text …>Orders</Text><Text …>{salesTotals.data.orders}</Text></Stack>
    <Stack gap={2}><Text …>Revenue</Text><Text …><MoneyValue value={ salesTotals.data.revenue } /></Text></Stack>
  </Group>
) }
```

Four pieces:

- **Detector Pattern H** (`api-hook-detector.ts`) — `<apiHandle>.<Projection>`,
  shaped like Pattern A minus the operation, because a projection read *has* no
  operation: the projection is the row. Ordered before Pattern D, whose `ref`
  arm would otherwise never see it.
- **`src/api/projections.ts`** (`_frontend/projections-module.ts`) — a
  `use<Proj>()` react-query hook per readable projection, its row schema built
  from the same `wireShape` the backend serves, so the two can't drift. Emitted
  only when one exists.
- **Single-record binding, derived not declared.** A singleton returns one
  object, so the collection semantics (`data.length === 0` / `> 0`) would read
  `.length` on an object and render nothing. `QueryView` derives `single` from
  the query the same way it already derives `paged` — the shape is a property of
  the query, not a decision the page should repeat.
- **One shared predicate** (`src/ir/util/projection-read.ts`) for *which*
  projections are readable, imported by the emitter, the walker's detector set,
  and the validator. A three-way disagreement here is exactly how
  `undefined.<Projection>` got emitted in the first place.

**The gate split in two**, because it asks two different questions:
`ui-checks.ts` F3 keeps the **flavour** half (a keyed or folded projection is
unreadable on *every* target), and `validateUiProjectionReadFramework`
(`system-checks.ts`) owns the **framework** half (react has the client; vue /
svelte / angular / feliz / flutter gate) — which needs a deployable in scope.

**A silent drop found on the way, and fixed:** a `money` KPI could not be
displayed at all. A bare value is `TS2322: Type 'Decimal' is not assignable to
type 'ReactNode'` (money deserialises client-side to a decimal.js `Decimal`),
and wrapping it — `Stat { "Revenue", Money { t.revenue } }` — rendered **empty**,
because `Stat`'s value slot coerced the nested primitive away. `emitStat` now
walks a nested walker-primitive in the value slot. Currency on a KPI card is the
canonical dashboard tile, so this was a hard blocker hiding behind the feature.

**Remaining:** keyed/collection projection reads (they want `Table`-shaped
binding); the five other frontends.

### 3.3 Phase 2 — `scaffoldDashboard` + the scaffolded projection · **LANDED**

```ddd
context Orders with scaffoldDashboard { aggregate Order { code: string  total: money  lineCount: int } … }
ui WebApp with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
```
→ the context gains `projection OrderTotals { rowCount: int  totalSum: money  lineCountSum: int
from Order as o  select rowCount = count(), totalSum = sum(o.total), lineCountSum = sum(o.lineCount) }`,
and `Home` — until now a welcome page whose only numbers were *compile-time counts
of declarations* — grows a live KPI row:

```tsx
const orderTotals = useOrderTotals();
{ orderTotals.data && (
  <Group data-testid="order-totals">
    … {orderTotals.data.rowCount} …
    … <MoneyValue value={ orderTotals.data.totalSum } /> …
  </Group>
) }
```

- **Two macros, one derivation.** A macro attaches to exactly one host, so the
  projection (`context`) and the page (`ui`) cannot come from one — the
  `scaffoldPaged`/`scaffoldPagedApi` split. Both halves derive the projection
  name in `_dashboard-shared.ts`, so a tile can't bind a projection the other
  half didn't emit.
- **One projection per aggregate, not per context** — a query-time projection
  has a single `from` source, so a per-context row would have nothing to
  aggregate over.
- **The ui half detects structurally**, so a *hand-written* `OrderTotals` lights
  up the dashboard too, with its own field list. It falls back to reading the
  context's `with scaffoldDashboard` clause because macro expansion order is
  source order (`streamAllContents`) — a ui declared before its context would
  otherwise see nothing.
- **Nullable columns are excluded on purpose.** SQL `SUM` skips NULLs, so a
  nullable column's tile would silently describe a different row set than the
  `rowCount` next to it — two numbers on one card that quietly disagree.
- **A coercion bug this surfaced, fixed in the Phase 0 emitter:** the coercion
  followed the select's *inferred* type while the response schema follows the
  *declared* row type, so a money sum emitted `Number(...)` into a `z.string()`
  field — `.parse` would reject it at runtime. The declared field is the
  contract.
- Additive: a system that never opts in keeps its welcome page byte-for-byte.

### 3.3b Original plan for Phase 2 (kept for the rationale) · `M` · **P1**

The maintainer's shape, and there is a clean in-tree precedent for the split:
**`scaffoldPaged` is a `context` macro whose `api` sibling `scaffoldPagedApi`
emits the matching route** — *"a route can never target a handler this macro
didn't emit."* A macro attaches to exactly one host (`MacroTarget = "aggregate" |
"ui" | "context" | "api"`, `define.ts:40`) and splices into that host's members,
so the projection and the page cannot come from one macro.

Proposed:

- **`scaffoldDashboard` — `target: "context"`.** Emits a singleton
  `projection <Ctx>Dashboard` with one aggregation per interesting field: a
  `count` per aggregate, a `sum` per `money` field. Derived from what is already
  in the context, exactly as `scaffoldList` derives columns.
- **The ui half.** Either grow `scaffoldHome`'s static cards into `Stat` cards
  bound to that projection, or add a ui-targeted `scaffoldDashboard` sibling
  alongside `scaffoldContext`/`scaffoldSubdomain`. Recommend **growing
  `scaffoldHome`** — the page already exists, is already routed and already in
  the menu; it just has no numbers. Gate the upgrade on the projection being
  present so a context without it keeps today's byte-identical welcome page.
- Both halves emit **final AST** carrying full unfoldable bodies, per the
  macros-emit-final-AST convention — so `unfold` ejects real `.ddd`.

**Ships a real dashboard with live server-computed numbers and ZERO new
primitives.** This is the cheap 80% and the point at which the feature is worth
demoing.

### 3.4 Phase 3 — `group by`: the series shape · `L` · **P2**

A time series *is* a group-by:

```ddd
projection RevenueByDay {
  day: date
  revenue: money
  from Order as o where o.status == Confirmed
  group by o.placedAt.date
  select day = o.placedAt.date, revenue = sum(o.total)
}
```

**✅ Shipped (with M-T4.2)** — `group by <col>, …` is in the grammar and emits
on all five backends: one grouped SQL query per read (GROUP BY + deterministic
ORDER BY over the grouping columns), the LIST response shape, the
`loom.projection-groupby-*` shape gates replacing the old reservation
(`docs/language-reference/10-repositories-and-queries.md` § "Grouped
projection"). The residual for the series shape above: a COMPUTED grouping key
(`o.placedAt.date` — date-truncating a datetime) is still gated
(`loom.projection-groupby-key-not-columnar`); bare-column keys (`o.status`,
`o.customerId`) work today. Frontend binding of a grouped projection stays
gated (`loom.ui-projection-read-unsupported`) until Phase 4's `Chart`/`Table`
binding. Dependency runs 3 → 4.

### 3.5 Phase 4 — the new primitives · `M`/`L` · **P2**

This is where the maintainer's *"then I would need probably new primitives"* lands.
Recommend **exactly one new primitive**:

- **`Chart { kind: "line" | "bar", of: <grouped projection>, x: λ, y: λ }`** —
  kind-discriminated, not separate `LineChart`/`BarChart`. One registry entry,
  one pack template per pack, one a11y contract. v1 is line + bar; no pie, area,
  scatter, donut, heatmap.
- **`Stat` grows `delta:`/`trend:`** rather than gaining a `Sparkline` sibling —
  KPI trend without a new primitive.

Follow the **DataGrid precedent now in flight** (PR #2294 — `DataGrid` on TanStack
Table): hoisted module-scope component, honest validator gate on unsupported
targets (`loom.chart-unsupported-target`), heex-parity pin with a reason,
temporary showcase exclusion, staged pack backfill, then flip
`REQUIRED_PRIMITIVES`. Coordinate with it — both add a library-backed primitive
to the same registry.

**The real cost is the pack matrix, not the walker.** 17 packs across 5 stack
families (`v1`, `v3`, `vue1`, `sv1`, `ng1`), 6 walker targets plus HEEx's parallel
engine. Each family needs a **new runtime dependency** in its
`stacks/*/stack-package-deps.hbs` and a `primitive-chart.hbs`. Sketch, to be
verified before committing: mantine → `@mantine/charts`; mui → `@mui/x-charts`;
shadcn/chakra → recharts; vuetify/shadcnVue → apexcharts or chart.js;
flowbite/shadcnSvelte → layerchart or chart.js; angularMaterial/primeng/spartanNg
→ ngx-charts or primeng's chart; HEEx → no JS-free option, so a Chart.js hook or
a parity pin. **This dependency spread is the single biggest cost item in the
mission** and the reason to land on the lead pack (mantine v9) first, gated.

**Accessibility is not paperwork here.** A chart is an image of data: `role="img"`
plus `aria-label`, or a visually-hidden data table. Skipping it fails
`generated-a11y`, and the WCAG-AA contrast gate has opinions about series colours.
Budget for it in the first slice.

Gates tripped, each to be *addressed* rather than loosened: `heex-parity`,
`allowlist-ratchet`, `showcase-completeness`, `pack-required-primitives`,
`a11y-contract-completeness`.

### 3.6 Phase 5 and the leftovers

- **`scaffoldDashboard` grows a per-day series** — ✅ landed. Each aggregate with
  a non-optional `datetime` column gains `<Agg>PerDay { day, rowCount }`, a
  GROUPED projection on the `startOfDay()` key, so the buckets are cut by
  `date_trunc('day', …)` in SQL. `createdAt` wins when present; otherwise the
  first non-optional datetime, so an aggregate modelling its own timestamp
  still charts. No datetime ⇒ no series (and the ui side derives the same
  answer, so it can never bind one that was not emitted).

  Landing it required fixing the divergence underneath it: the macro expander
  runs BEFORE Langium's linker and its `makeRef` is lenient, but projection
  lowering read `p.source?.ref` only — so a scaffolded projection's source
  never resolved, `candidateAlias` was never bound, and a bare `o` never became
  `this`. Macro-built and parsed projections lowered to DIFFERENT IR from the
  same source text. That is the root cause behind experience_gathered §70 (it
  is why the aggregate-arg gate rejected `scaffoldDashboard`'s own
  `sum(o.total)`), and `test/ir/macro-vs-parsed-projection-lowering.test.ts`
  now pins the invariant.

- **The `Chart` TILE on `scaffoldHome` is still open**, and blocked on a real
  constraint rather than effort: `Chart` renders on **react only**, but a
  scaffolded `ui` can be hosted by a deployable of any framework, and the
  macro cannot see which — the `ui` declaration carries no framework, the
  deployable binds it later. Adding the tile unconditionally would fail every
  vue/svelte/angular/elixir scaffold with `loom.chart-unsupported-target`
  (verified: a vue-hosted scaffold generates clean today). Unblocking it needs
  one of — `Chart` on the remaining frontends, a framework-aware scaffold, or
  a page-level "render only where supported" primitive. That is a design
  decision, not a slice.
- **Defect A** (§2.2) — no longer on the critical path. Recommend the cheap half:
  a validator gate `loom.frontend-collection-op-unsupported` so `rows.count`
  fails at parse time instead of at `tsc`. Map ops into the JSX walkers only if
  authors turn out to want client-side derived numbers; the tail (`sortBy`,
  `distinct`, `take`, `join`) is `Table`'s job and already has a server path.
- **Defect B** (§2.3) — largely dissolved by Phase 0–2 (the number comes from the
  projection, not the page). Exposing `rows.total` on the paged binding stays a
  nice small win; note the `pagedDataIsList` wrinkle at `walker-core.ts:1411`
  (Feliz has no envelope).

### 3.7 Landed already — the two honest gates (slice 1)

Before any of the phases above, the two **silent** holes are now closed, so
every later slice is a *lift* of a named gate rather than a hunt for what is
broken. `src/ir/validate/checks/`:

| Code | Rejects | Lifted by |
|---|---|---|
| `loom.projection-whole-table-aggregation-unsupported` | an aggregating `select` hosted on a backend that hasn't ported the SQL push-down. **Now per-deployable** (`system-checks.ts`), lifted on node by Phase 0 | the remaining four backends |
| `loom.projection-select-unresolved` | any *other* unresolved name in a `select` — the general form of the same defect (a typo emitted as a free identifier) | — (permanent) |
| `loom.projection-groupby-unsupported` | an aggregate `select` mixed with a per-row one — a GROUP BY, reserved rather than guessed at | Phase 3 |
| `loom.ui-projection-read-unsupported` | **split in Phase 1** into a FLAVOUR half (`ui-checks.ts` — a keyed/folded projection, unreadable on every target) and a FRAMEWORK half (`system-checks.ts` — react has the client, the other five gate) | keyed reads; the five other frontends |

Two IR shapes had to be covered for the aggregation gate, which is why half a
fix would have leaked: a bare `count` lowers to `refKind: "unknown"`, while
`sum(o.total)` lowers to `callKind: "free"` — documented in the `CallKind` union
as *"unresolved free call"*. Either one reaches the emitter verbatim, because
every backend's query-time projection emitter renders the `select` expr straight
into its row mapper with no further name resolution.

**A note on how these survived: `ddd parse` does not run phase ⑦.** The IR
validator runs on `generate` (and in the test harness), not on `parse` — so the
cheap check an author reaches for reports `0 errors` on a model whose IR tier was
never consulted. Worth remembering when reading the "validates clean" claims
above: they were true at both tiers *before* this slice, but `parse` alone will
stay quiet about IR-tier gates by design.

### 3.8 Ordering

0. **Slice 1 — the honest gates (§3.7).** ✅ landed.
1. **Phase 0** — singleton aggregation actually computes (Defect C). ✅ landed on
   node; the four other backends each lift their own gate.
2. **Phase 1** — ui can read a projection (Defect D). ✅ landed on react
   (singleton only); keyed reads + the five other frontends remain.
3. **Phase 2** — `scaffoldDashboard` + `scaffoldHome` upgrade. ✅ landed. **A real
   dashboard ships here, with no chart dependency anywhere.**
4. **Phase 3** — `group by` (with M-T4.2). ✅ landed, and the computed date-key
   refinement with it: `group by o.placedAt.startOfDay()` (a catalogued
   queryable `datetime` intrinsic → `date_trunc('day', …)`) makes the daily
   series a first-class grouping key on all five backends. Verified by BOOTING
   each backend against Postgres, which is the only way it could have been:
   four of the five were wrong in the read-back position, where the bucket
   arrives OUTSIDE the ORM's schema type mapping and every failure was a
   runtime one — Drizzle hands a raw `sql` member back as text
   (`.toISOString is not a function`), SQLAlchemy rendered the unit as a bind
   param (Postgres then rejected the grouped select outright), a `datetime`
   key was returned unencoded (FastAPI 500), and Ecto's `fragment` bypassed the
   `:utc_datetime` mapping (`…T00:00:00.000000` vs `…T00:00:00Z` — a wrong
   VALUE, silent). Java got a defensive normaliser for the same class. All five
   now answer identically. Separately, this surfaced a shipped Python bug with
   nothing to do with grouping: a query-time projection was mapped as a keyless
   read-model table, so `configure_mappers()` threw and **any** generated
   FastAPI app containing one — including the Phase 0 singleton — failed to
   boot. Fixed here.
5. **Phase 4** — `Chart` on mantine v9, gated, a11y in slice 1. ✅ landed
   (`Chart { kind, of, x, y }` over grouped projections; react + mantine@v9,
   `loom.chart-*` gates elsewhere; grouped projections became frontend-readable
   with the LIST-shape client on the way).
6. **Phase 5** — pack backfill + `REQUIRED_PRIMITIVES` flip ✅ landed; scaffolded
   chart still open. All **eight** tsx packs now ship `primitive-chart`, so
   `primitive-chart` joined `REQUIRED_PRIMITIVES.tsx.core` and
   `loom.chart-unsupported-target` collapsed from a per-PACK set to the same
   per-FRAMEWORK rule `DataGrid` uses — vue/svelte/angular/feliz/flutter/HEEx
   stay honest gaps. Library bindings landed as the mission sketched them:
   `@mantine/charts` (mantine v7/v9), `@mui/x-charts` (mui v5/v7), recharts
   direct (shadcn v3/v4, chakra v2/v3), each a conditional dependency keyed on
   `usesChart`, each dressed in that pack's own tokens rather than a chart-only
   palette.

   Verified by `npm install` + `tsc --noEmit` on a generated project **per
   pack**, which is what caught the two defects worth recording. (a) The
   **series was never numeric**: a `money` field parses client-side into a
   `Decimal`, and no chart library can plot an object — `@mui/x-charts` rejects
   it at compile time while recharts and `@mantine/charts` compile and then
   render NOTHING. That was a live bug in the merged Phase 4 emit, on the single
   most likely series there is (`revenue = sum(o.total)`); the walker now
   projects each row to its two plotted columns and coerces the series with
   `Number(...)`. Projecting rather than spreading matters too — a sibling money
   column fails the same `dataset` type even when the plotted series is clean.
   (b) The **kind-specific import filter was hardcoded** to `LineChart`/
   `BarChart`, which is all a mantine/mui pack names; a recharts pack also
   imports the per-kind MARK (`Line`/`Bar`) alongside shared pieces, so the
   filter became a per-kind name SET or the generated project failed
   `noUnusedImports`.

Steps 1–3 are the cheap 80% and carry no third-party charting dependency. Worth
shipping and living with before paying step 4–6's 17-pack cost.

## 4. Explicitly out of scope for v1

Drill-down / click-through from a chart; realtime-updating charts (M-T1.10
territory); pie / scatter / heatmap / sparkline; per-series colour authoring
beyond the pack's design tokens; export-to-CSV.

**A composite `Dashboard(items: [...])` container is out of scope by prior
decision *and* by maintainer steer** — designed in `examples/sales-ui.ddd` and
dropped in favour of *"compose them from a list + `state {}` + display
primitives"* (§2.3). `Grid`, `Card`, and `Stack` already do the layout; nothing
here needs a new container.

## 5. The escape hatch stays, and should be documented as the answer

`extern component` ships on every frontend (M-T1.4 `done`) and its own proposal
uses a chart as the worked example. Anything outside the closed set — a funnel, a
Gantt, a map — is an `extern component`, and saying so explicitly in
[`docs/page-metamodel.md`](../../page-metamodel.md) is what lets the built-in set
stay two chart kinds instead of growing to twelve.

---

## Appendix — reproduction

```bash
node bin/cli.js parse   scratch/kpi.ddd          # 0 errors, 0 warnings
node bin/cli.js generate system scratch/kpi.ddd -o out

cd out/web && npm install && npx tsc --noEmit
#   src/pages/dash.tsx(25,59): error TS2339: Property 'count' does not exist on type '{…}[]'.
cd out/api && npm install && npx tsc --noEmit
#   http/query-projections.ts(35,15): error TS2304: Cannot find name 'count'.
```

Both are the exact checks `generated-react-build.yml` and `hono-build.yml` run.
Neither fires on `main` because no example or corpus fixture exercises either
surface. The Defect D repro is the same fixture with the page body swapped to
`QueryView { of: Sales.SalesTotals, data: r => Stat { "Total orders", r.orders } }`
— it validates clean and emits `undefined.SalesTotals`.

**Compile coverage now exists.** `test/e2e/fixtures/ts-build/projection-aggregation.ddd`
is the first `.ddd` in the repo to use a `select` clause at all — the whole
query-time projection surface, shipped on five backends, had none — and it runs
under `LOOM_TS_BUILD=1` (real `tsc --noEmit` + `tsup` bundle). The remaining two
repro fixtures (page collection-op, ui-reads-projection) are worth promoting when
Phase 1 starts.
