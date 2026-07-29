# M-T1.3 — Charts & the dashboard ceiling — scoping pass

> **Status:** scope only — nothing implemented. Written 2026-07-29 against fresh
> `main` (`52c62e1`), with every claim below produced by *generating and
> compiling output*, not by reading the tracker.
>
> **Headline finding:** charts are not a rendering problem first. The three
> defects in §2 mean that **today, the most natural way to put a number on a
> page produces a project that does not compile** — on the frontend *and* on the
> backend. A `Chart` primitive dropped on top of that would render a wrong
> number prettily. The mission therefore splits into a data half that must go
> first and a component half that follows.

---

## 1. Where the ask comes from

Three documents converge, and none of them is the chart proposal people
remember — the vision is spread across them:

| Source | What it says |
|---|---|
| [`T1-ui-frontend.md`](../T1-ui-frontend.md) **M-T1.3** | The whole mission, today, is one line: *"A minimal `Chart` primitive (line/bar over a collection expr). Keep the set closed and small; HEEx renderer required or pinned."* |
| [`completeness-audit-2026-07.md`](../../audits/completeness-audit-2026-07.md) Tier 2 → Frontend | *"**No charts/dashboards** beyond the two-line `Stat` card — no time series, no KPI trend, no drill-down. **(Pairs with the missing aggregation queries.)**"* — the parenthetical is the entire scoping problem. |
| [`read-path-architecture.md`](../../old/proposals/read-path-architecture.md) rev. 8 | Designs the data half and names the use case verbatim: keying is *"a second orthogonal axis — keyed collection vs unkeyed **singleton** (a whole-table read model: **dashboard total / running count**, which `projection.md` deferred)"*. Query-time singletons *"need **aggregation binds** (`count`/`sum`) — a real add `view` lacked."* Group-by is explicitly reserved behind `loom.projection-groupby-unsupported`. |

There is also a fourth, quieter source: the
[extern-component escape hatch](../../old/proposals/extern-component-escape-hatch.md)
uses a **chart** as its motivating example throughout
(`component PriceChart(series: Order[], height: int) extern from "./widgets/price-chart"`).
That escape hatch **ships** and is at frontend parity (M-T1.4, `done`). So a
hand-written chart is already possible today; what is missing is a *first-class,
scaffoldable* one — and the data to put in it.

## 2. What actually ships today — three defects, all verified by generating

The fixture used throughout is a two-file system with one `Order { code, total: money }`
aggregate, a React ui, and a Hono backend (`page Dash` + a singleton projection).

### 2.1 What a "dashboard" is today

- **`Stat(label, value)`** is the *only* KPI primitive (`_walker/primitives/display.ts:13`).
  No pack has a dedicated component for it — all 17 render two stacked text
  elements (dimmed label, bold value). It takes an arbitrary value expression.
- **`scaffoldHome` has no numbers in it at all**
  (`src/macros/stdlib/scaffold/_body-builders.ts`). The scaffolded "dashboard"
  is a welcome page: a heading, a sentence, and up to two static cards reading
  *"3 aggregates / Manage records of each kind from the sidebar."* The counts in
  that string are **compile-time counts of declarations**, not runtime data.
- The aggregation vocabulary *is* documented in the language
  ([`docs/stdlib.md`](../../stdlib.md) → Collection operations): `count`, `sum(λ)`,
  `avg(λ)`, `min(λ)`, `max(λ)`, `where(λ)` — flagged there as in-memory and
  **non-queryable**.

### 2.2 Defect A — collection ops do not survive the JSX walker (`tsc`-provable break)

```ddd
page Dash {
  route: "/dash"
  body: Stack {
    Heading { "Dashboard", level: 1 },
    QueryView { of: Sales.Order.all, data: rows => Stat { "Total orders", rows.count } }
  }
}
```

`ddd parse` → **`0 error(s), 0 warning(s)`**. `ddd generate system` →
`web/src/pages/dash.tsx`:

```tsx
<Text fw={700} size="xl">{orderAll.data.items.count}</Text>
```

Real compiler, real `npm install`, in the generated project:

```
src/pages/dash.tsx(25,59): error TS2339: Property 'count' does not exist on type
  '{ id: string; code: string; total: Decimal; version: number; display: string; }[]'.
```

The cause is one line: `walker-core.ts:1428` emits member access verbatim
(`` `${emitExpr(expr.receiver, ctx)}.${expr.member}` ``). There is **no
`isCollectionOp` arm anywhere on the JSX walker path** — `grep isCollectionOp`
returns zero hits across `_walker/`, `react/`, `vue/`, `svelte/`, `angular/`.
The two places that do handle it are narrow: `_frontend/gate-expr.ts:52` and
`feliz/auth-gate.ts:125` special-case `contains` for auth gates only.

Per-frontend, the same expression:

| Frontend | `rows.count` becomes | Result |
|---|---|---|
| React / Vue / Svelte / Angular | `rows.count` | **`tsc` / `vue-tsc` / `svelte-check` / `ng build` break** |
| Feliz | `(List.length rows)` | correct — `fs-expr.ts:121` has the leaf table |
| Flutter | `rows.count` | `DART_LEAVES` has no collection-op arm (Dart's `.length`) |

So the one frontend nobody thinks of first is the only one that gets it right,
because it is the only one whose expression renderer is a real leaf table.

**Why CI never caught it:** no example or corpus fixture uses a collection op in
a page body. `Stat` appears in six `.ddd` files and every one passes it a
literal, a state field, or a lambda param — never an aggregation.

### 2.3 Defect B — a client-side KPI over `.all` is page-scoped even when it compiles

`.all` has been `Paged<T>` by default since M-T2.6 (`enrichments.ts:1685`), and
the generated query defaults to `pageSize: 20`. So `rows` in the snippet above
is **at most 20 rows**. Had `.count` worked, "Total orders" would have read
`20`.

The right number is sitting one field away in the envelope the frontend already
parses —

```ts
export const OrderPaged = z.object({ items: …, page: …, pageSize: …, total: z.number().int(), totalPages: … });
```

— and **the DSL has no way to reach `total`.** This is the sharpest statement of
why the mission is data-first: the correct value is already on the wire, already
typed, and unaddressable.

**Prior art, and a prior decision.** Syntax for exactly this was designed and
dropped. `examples/sales-ui.ddd` — a self-described *"HISTORICAL prototype …
does NOT parse with the current Langium grammar"* — carries a whole
`page SalesDashboard` sketch:

```ddd
body: Dashboard(items: [
  Card { "Confirmed orders", Stat { api Sales.Order.all, format: "count" } },
  Card { "EUR/USD",          Stat { api ExchangeRates.usd("EUR"), decimals: 4 } },
  Card { "Customer breakdown", Table { api Sales.Customer.all }, span: 2 }
])
```

Its own header records the outcome: *"`MasterDetail`, **`Dashboard`**, and
`Review` were dropped (compose them from a list + `state {}` + display
primitives)"*. So a **composite `Dashboard` primitive has already been
considered and rejected** — that decision should stand (see §5), and it is a
further argument that the missing piece is the *data binding*
(`Stat { api …, format: "count" }`), not a layout container.

### 2.4 Defect C — the singleton aggregating projection silently mis-emits (the serious one)

`read-path-architecture` rev. 8's singleton — the designed answer to Defect B —
**parses and validates clean today**:

```ddd
projection SalesTotals {
  orders: int
  from Order as o
  select orders = count
}
```

→ `0 error(s), 0 warning(s)`. And then it emits, in
`api/http/query-projections.ts`:

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
  const rootRows = await this.db.select().from(schema.orders);   // ← SELECT * , whole table
  …
  const result = rootRows.map((root) => Order._rehydrate({ … }));  // ← rehydrate every row
  return result;
}
```

Three things wrong at once: an **unbounded full-table load** (precisely the
scaling failure M-T2.6 just removed from `findAll`), **every row rehydrated into
a domain object** to produce one integer, and a **free identifier `count`** that
does not compile.

This is exactly the silent mis-emit the projection validator's own header claims
is prevented — `projection-checks.ts:185-200` says the query-time surface is
*"HONESTLY REJECTED until a backend ports the emit … rather than silently
mis-emitted by the folded path."* The gate `loom.projection-query-time-unsupported`
does not fire here because node/Hono **has** ported the query-time emitter; the
comment at `:198` says the *"groupby / singleton-whole-table-aggregation /
paged-sort refinements land WITH that emit"* — they did not, and no gate was left
behind to say so. The honest-gap discipline held for the backends without the
emitter and leaked on the one that has it.

**This is worth fixing regardless of whether charts are ever built**, and it is
the smallest, highest-value slice in this document.

### 2.5 What this adds up to

| Layer | State |
|---|---|
| Server-computed aggregate | designed (rev. 8), **not built**; the surface parses and mis-emits |
| Group-by / time series | **not in the grammar at all** (`grep "group by"` → nothing); reserved in the proposal |
| Aggregation reaching a page expression | **broken** on 4/6 frontends, correct on Feliz |
| Paged `total` reachable from the DSL | **no** |
| KPI component | `Stat`, unstyled, works with any value expression |
| Chart component | none; `extern component` is the escape hatch and it works |

## 3. Proposed scope — three missions, sequenced

The current M-T1.3 (`open · M · P2`) is under-scoped as one item. Recommend
splitting:

### M-T1.3a — aggregation reaches the page — `S` · **P1** · chart-free

Ships value with no chart in sight: KPI cards that are *correct*.

1. **Collection-op leaf mapping for the JSX walker + Dart.** Mirror the Feliz
   leaf table. Recommend mapping a **deliberately small set** — `count`,
   `where`, `sum`, `avg` — and adding an honest validator gate
   `loom.frontend-collection-op-unsupported` for the tail (`sortBy`, `distinct`,
   `take`, `skip`, `join`, `map`, `first`), which are `Table`'s job and already
   have a server-side path via M-T1.1 slice 9. Mapping everything invites a
   second, divergent expression dialect in the frontends; gating the tail keeps
   the surface honest and the diff small. Natural home: a shared
   `src/generator/_frontend/collection-ops.ts` consumed by the four JSX targets,
   with Dart/Feliz keeping their own leaf tables.
2. **Reach the paged `total`.** Decide between exposing the envelope field on
   the QueryView binding (`rows.total`) and a dedicated read. The envelope field
   is smaller and honest — the value is already parsed and typed. Note the
   `pagedDataIsList` wrinkle at `walker-core.ts:1411`: Feliz decodes a paged
   `.all` to a bare list with no envelope, so `total` needs a per-target seam
   there or an explicit Feliz gap.
3. **Fix Defect C's gate at minimum** — either implement whole-table aggregation
   properly or make it an error. Shipping a `# TODO`-free undefined identifier is
   the one outcome that is not acceptable.
4. **Acceptance:** the `Dash` page above compiles under `generated-react-build`
   *and* reports the true total against a seeded backend. Reuse
   `test/behavioral/pagination.mjs`'s existing 1000-row seed — the harness is
   already there.

### M-T1.3b — the `Chart` primitive — `M`/`L` · **P2**

Shape is largely settled by the **DataGrid precedent in flight right now**
(PR #2294, `DataGrid` on TanStack Table). That PR is the template: hoisted
module-scope component, honest validator gate on unsupported targets, heex
parity pin with a reason, temporary showcase exclusion, staged pack backfill,
then flip `REQUIRED_PRIMITIVES`. Follow it rather than inventing a second
pattern — and **coordinate with it**, since both add a library-backed primitive
to the same registry.

- **Closed set v1: `line` and `bar` only.** No pie, area, scatter, donut, or
  heatmap. The mission line already says this; hold it.
- **The real cost is the pack matrix, not the walker.** 17 packs across 5 stack
  families (`v1`, `v3`, `vue1`, `sv1`, `ng1`), 6 walker targets plus HEEx's
  parallel engine. Each pack family needs a **new runtime dependency** in its
  `stacks/*/stack-package-deps.hbs` and a `primitive-chart.hbs`. Sketch of the
  natural per-family choice (needs a verification pass before committing):
  mantine → `@mantine/charts`; mui → `@mui/x-charts`; shadcn/chakra → recharts;
  vuetify/shadcnVue → apexcharts or chart.js; flowbite/shadcnSvelte →
  layerchart or chart.js; angularMaterial/primeng/spartanNg → ngx-charts or
  primeng's chart; HEEx → no JS-free option, so either a Chart.js hook or a
  parity pin with a reason. **This dependency spread is the single biggest cost
  item in the mission** and the reason to land on the lead pack (mantine v9)
  first behind a gate.
- **Accessibility is not paperwork here.** A chart is an image of data:
  `role="img"` plus an `aria-label`, or a visually-hidden data table. Skipping it
  fails `generated-a11y` and the WCAG-AA contrast gate has opinions about series
  colours too. Budget for it in the first slice, not a follow-up.
- Gates tripped, each to be *addressed* rather than loosened:
  `heex-parity`, `allowlist-ratchet`, `showcase-completeness`,
  `pack-required-primitives`, `a11y-contract-completeness`.

### M-T1.3c — grouped aggregation: the time-series data source — `L` · **P2**

The half that makes a chart worth having. A time series **is** a group-by:

```ddd
projection RevenueByDay {
  day: date
  revenue: money
  from Order as o where o.status == Confirmed
  group by o.placedAt.date
  select day = o.placedAt.date, revenue = sum(o.total)
}
```

`group by` is not in the grammar; `read-path-architecture` reserves it behind
`loom.projection-groupby-unsupported` (a code that, per the grep, does not exist
in `src/` yet either — the reservation is documented, not enforced). This belongs
with the read-path work in **M-T4.2** rather than in a UI mission; the dependency
runs 1.3c → 1.3b, not the reverse.

## 4. Recommended ordering

1. **M-T1.3a** now — small, unblocks correct KPI cards, and closes a live
   `tsc`-provable codegen break on the four JSX frontends.
2. **Defect C** (§2.4) as its own slice, immediately — it is a silent mis-emit
   with an unbounded table scan behind it, independent of everything else here.
3. **M-T1.3c singleton** — server-computed KPI, the designed answer to Defect B.
4. **M-T1.3b** on mantine v9 only, gated, with a11y in the first slice.
5. **M-T1.3c group-by** — charts get real series.
6. Pack backfill; flip `REQUIRED_PRIMITIVES`.

Steps 1–3 deliver a genuine dashboard (correct KPI cards on a scaffolded home
page) with **no chart library dependency anywhere**. That is the cheap 80%, and
it is worth shipping before deciding whether the pack-matrix cost in step 4 is
one the project wants.

## 5. Explicitly out of scope for v1

Drill-down / click-through from a chart; realtime-updating charts (M-T1.10
territory); pie / scatter / heatmap / sparkline; per-series colour authoring
beyond the pack's design tokens; export-to-CSV.

**A dashboard *layout* DSL (a grid of widgets) is out of scope by prior
decision, not by omission** — `Dashboard(items: [...])` was designed in
`examples/sales-ui.ddd` and explicitly dropped in favour of *"compose them from a
list + `state {}` + display primitives"* (§2.3). `Grid`, `Card`, and `Stack`
already do the layout; nothing in this mission needs a new container.

## 6. The escape hatch stays, and should be documented as the answer

`extern component` ships on every frontend (M-T1.4 `done`) and its own proposal
uses a chart as the worked example. Anything outside the closed set — a funnel,
a Gantt, a map — is an `extern component` and should be documented as such in
[`docs/page-metamodel.md`](../../page-metamodel.md). Saying so explicitly is what
lets the built-in set stay two chart kinds instead of growing to twelve.

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
Neither fires on `main` today because no example or corpus fixture exercises
either surface.

`scratch/kpi.ddd` is the fixture in §2 — one aggregate, one `page Dash` with the
`QueryView`/`Stat` body, and the `projection SalesTotals` from §2.4. Worth
promoting to `test/fixtures/corpus/` when M-T1.3a starts.
