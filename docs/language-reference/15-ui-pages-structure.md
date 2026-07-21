# 15. UI: pages & structure

The frontend surface: a `ui` block bound to a frontend deployable, holding `page`s (route + body), `component`s (reusable region trees), reactive `state` / `derived` / `action` members, an optional explicit `menu`, page-grouping `area`s, and the `with scaffold(...)` macro that synthesises CRUD pages from the domain. Reach for this chapter to learn exactly what a page or component emits — and where the five frontends diverge.

> **Grammar:** `Ui`, `UiMember`, `Page`, `PageProp`, `Component`, `StateBlock`, `StateField`, `DerivedProp`, `ActionDecl`, `Area`, `MenuBlock`, `Layout` · **Validators:** `loom.react-deployable-missing-ui` · `loom.framework-mismatch` · `loom.ui-framework-unhostable` · `loom.component-missing-body` · `loom.slot-out-of-position` · **Docs:** [`../page-metamodel.md`](../page-metamodel.md), [`../scaffold-macros.md`](../scaffold-macros.md)

The page metamodel is **framework-neutral**: one `ui { … }` source lowers onto React (`react`), Vue 3 (`vue`), SvelteKit (`svelte`), or Angular (`angular`) by switching the bound deployable's `platform:` (or the ui's `framework:`). Every `frontend` tab below is **real generated output** from the same `.ddd` — only the host framework's idiom differs.

## `ui` block & deployable binding

A `ui` is a `SystemMember` (peer to `subdomain`, `deployable`, `theme`). A frontend deployable mounts it via `ui: <Name>`; the binding can pass per-module api handles (`ui: WebApp { Sales: api }`). Inside, `api <name>: <Contract>` declares a local handle on a system `api` contract that page data bindings resolve against (`Sales.Order.byId(id)`). Every frontend deployable **must** name a ui — its absence is a hard error (`loom.react-deployable-missing-ui` and the `vue`/`svelte`/`angular` siblings); the deployable without a ui is a host with no mount point.

```ddd
system Frontends {
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation confirm() { }
        operation cancel() { }
      }
      repository Orders for Order { }
    }
  }

  api SalesApi from Sales

  ui WebApp with scaffold(aggregates: [Order]) {
    api Sales: SalesApi
    page Home { route: "/" body: Heading { "Action showcase", level: 1 } }
  }

  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }

  deployable api {
    platform: node
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 3000
  }

  deployable webApp {
    platform: react       // ← swap for vue | svelte | angular
    targets: api
    ui: WebApp { Sales: api }
    port: 3001
  }
}
```

The `framework:` key on the ui block sets its framework independently of the host (`ui Ops { framework: react }` on a `platform: static` host) — `loom.ui-framework-unhostable` rejects a framework the host can't serve, `loom.framework-mismatch` a host/ui contradiction.

## `page` — route, title, body

A page is a route + optional typed parameters + a single-expression `body:`. Path params (`:id`) bind to declared parameters and lower to the framework's route-param hook. The body is one walker expression — a layout primitive, a component invocation, a `QueryView`, or a `match`.

```ddd
page Home {
  route: "/"
  body: Heading { "Action showcase", level: 1 }
}
```

The page file lands at the framework's idiomatic route location, default-exported as the route component.

::: tabs frontend
== react
```tsx
// src/pages/home.tsx
import { Title } from "@mantine/core";

export default function Home() {
  return (
    <Title order={1}>Action showcase</Title>
  );
}
```
== vue
```vue
<!-- src/pages/home.vue -->
<template>
  <h1>Action showcase</h1>
</template>
```
== svelte
```svelte
<!-- src/routes/(app)/+page.svelte -->
<h1 class="text-3xl font-bold tracking-tight">Action showcase</h1>
```
== angular
```ts
// src/app/pages/home.component.ts
@Component({
  selector: "app-home",
  imports: [],
  template: `<h1>Action showcase</h1>`,
})
export class HomeComponent {}
```
::: end

Other `PageProp`s: `title:` (string expression, may interpolate page data), `requires <expr>` (auth gate — renders a client-side `<Forbidden/>` guard on `auth: ui` frontends; see [`../auth.md`](../auth.md)), `state { … }` / `derived` / `action` (below), `menu { … }` (per-page sidebar metadata), and the SEO props `description:` / `ogImage:` / `canonical:`. The route grammar accepts a `STRING` only; the path-param binding is positional against `params`.

## `component` — reusable region tree

A `component` is a typed function from parameters (and optional local state) to a `body:` expression. It never declares a route. Parameters may be primitives, **aggregate instances** (`order: Order` — `order.confirm` resolves to the operation, and the walker hoists the matching mutation hook into the body), or `slot` markers (caller-supplied JSX, walked in the *caller's* scope). Components live `ui`-scoped or top-level (a `.ddd` can be a pure component library).

```ddd
component OrderActions(order: Order) {
  body: Toolbar {
    Action { order.confirm, then: navigate(Home) },
    Action { order.cancel }
  }
}
```

Each `Action { order.<op> }` wires a `use<Op>Order(order.id)` mutation; `then: navigate(Home)` chains a router push after the mutation resolves.

::: tabs frontend
== react
```tsx
// src/components/OrderActions.tsx
import { useNavigate } from "react-router";
import { Button, Group } from "@mantine/core";
import type { OrderResponse } from "../api/order";
import { useCancelOrder, useConfirmOrder } from "../api/order";

export default function OrderActions({ order }: OrderActionsProps) {
  const navigate = useNavigate();
  const confirmOrder = useConfirmOrder(order?.id);
  const cancelOrder = useCancelOrder(order?.id);
  return (
    <Group justify="space-between">
      <Button onClick={() => void confirmOrder.mutateAsync({}).then(() => { navigate("/"); })} loading={confirmOrder.isPending}>Confirm</Button>
      <Button onClick={() => void cancelOrder.mutateAsync({})} loading={cancelOrder.isPending}>Cancel</Button>
    </Group>
  );
}
```
== vue
```vue
<!-- src/components/OrderActions.vue -->
<script setup lang="ts">
import { reactive } from "vue";
import { useRouter } from "vue-router";
import type { OrderResponse } from "../api/order";
import { useCancelOrder, useConfirmOrder } from "../api/order";
const props = defineProps<{ order: OrderResponse }>();
const router = useRouter();
const confirmOrder = reactive(useConfirmOrder(props.order?.id));
const cancelOrder = reactive(useCancelOrder(props.order?.id));
</script>
<template>
  <div class="d-flex align-center justify-space-between ga-3">
    <v-btn @click='() => void confirmOrder.mutateAsync({}).then(() => { router.push("/"); })' :loading='confirmOrder.isPending'>Confirm</v-btn>
    <v-btn @click='() => void cancelOrder.mutateAsync({})' :loading='cancelOrder.isPending'>Cancel</v-btn>
  </div>
</template>
```
== svelte
```svelte
<!-- src/lib/components/OrderActions.svelte -->
<script lang="ts">
  import { goto as navigate } from "$app/navigation";
  import type { OrderResponse } from "$lib/api/order";
  import { useCancelOrder, useConfirmOrder } from "$lib/api/order";
  let { order }: { order: OrderResponse } = $props();
  const confirmOrder = useConfirmOrder(() => order?.id);
  const cancelOrder = useCancelOrder(() => order?.id);
</script>

<div class="flex flex-row items-center justify-between gap-4">
  <button type="button" class="loom-btn loom-btn-primary" onclick={() => void confirmOrder.mutateAsync({}).then(() => { navigate("/"); })}>Confirm</button>
  <button type="button" class="loom-btn loom-btn-primary" onclick={() => void cancelOrder.mutateAsync({})}>Cancel</button>
</div>
```
::: end

> **Honest gap — Angular doesn't render user-`component` invocations.** Angular emits no standalone file for `component OrderActions`, and a page that invokes it renders a placeholder comment instead of the component:
> ```ts
> @if (orderById.data()) {
>   <!-- unknown layout component: OrderActions -->
> }
> ```
> Aggregate-param components with hoisted operation hooks are a React/Vue/Svelte feature today. Angular's frontend covers scaffolded pages and the builtin primitive library; custom `component` composition is not yet wired through its walker.

A component with no `body:` (and no `extern from "…"`) is rejected by `loom.component-missing-body`; `extern from "path"` declares a hand-written component the generator references but does not emit.

## `state` / `derived` / `action`

A `state { … }` block declares reactive local fields (`name: Type = init`); `derived name: Type = Expr` is a computed read; writes use `:=`. Each lowers to the framework's native reactivity primitive — and that mapping **is** the cross-framework divergence.

```ddd
page Counter {
  route: "/counter"
  state { count: int = 0 }
  derived label: string = "Clicks: " + count
  body: Stack {
    Heading { label, level: 2 },
    Button { "Increment", onClick: e => { count := count + 1 } }
  }
}
```

::: tabs frontend
== react
```tsx
// useState + useMemo; `:=` lowers to the setter
import { useState, useMemo } from "react";
export default function Counter() {
  const [count, setCount] = useState<number>(0);
  const label = useMemo(() => ("Clicks: " + String(count)), [count]);
  return (
    <Stack>
      <Title order={2}>{label}</Title>
      <Button onClick={() => { setCount((count + 1)); }}>Increment</Button>
    </Stack>
  );
}
```
== vue
```vue
<!-- ref + computed; setter wraps the .value write -->
<script setup lang="ts">
import { computed, ref } from "vue";
const count = ref(0);
const setCount = (v: typeof count.value) => { count.value = v; };
const label = computed(() => ("Clicks: " + String(count.value)));
</script>
<template>
  <h2>{{ label }}</h2>
  <v-btn @click='() => { count = (count + 1); }'>Increment</v-btn>
</template>
```
== svelte
```svelte
<!-- Svelte 5 runes: $state + $derived; `:=` is an in-place assignment -->
<script lang="ts">
  let count = $state<number>(0);
  const label = $derived(("Clicks: " + String(count)));
</script>
<h2 class="text-2xl font-semibold tracking-tight">{label}</h2>
<button type="button" onclick={() => { count = (count + 1); }}>Increment</button>
```
::: end

`action name(params) { stmts }` names a handler so it can be referenced by identity instead of an inline lambda — positionally distinct from the `action(T)` param type and the `Action {}` render primitive (`loom.action-out-of-position` guards the slot). `+=` / `-=` are **type-driven**: arithmetic on a scalar target, append/remove on a collection target (`tags += newTag` → `[...tags, newTag]`). Nested writes (`draft.zip := v`) rebuild immutably on React, mutate in place on Vue/Svelte.

## `QueryView` & page parameters

`QueryView { of:, loading:, error:, empty:, data:, single?: }` branches on the four async states of a repository find. A `data: o => …` lambda binds the loaded record; the `o` parameter resolves in the lambda's scope (so an aggregate-param component can consume it). Path params declared on the page bind to the framework's route-param hook.

```ddd
page OrderConsole {
  route: "/console/:id"
  body: QueryView {
    of: Sales.Order.byId(id),
    single: true,
    loading: Loader {},
    empty: Empty { "Order not found" },
    data: o => OrderActions(order: o) }
}
```

::: tabs frontend
== react
```tsx
// src/pages/order_console.tsx
export default function OrderConsole() {
  const { id } = useParams<{ id: string }>();
  const orderById = useOrderById(id);
  return (
    <>
      { orderById.isLoading && ( <Loader /> ) }
      { orderById.isError && ( null ) }
      { !orderById.isLoading && !orderById.isError && !orderById.data && (
        <Center mih={200}><Text c="dimmed">Order not found</Text></Center>
      ) }
      { orderById.data && ( <OrderActions order={orderById.data} /> ) }
    </>
  );
}
```
== angular
```ts
// src/app/pages/order-console.component.ts — the QueryView arms render,
// but the OrderActions invocation degrades (see the component gap above)
@Component({ /* … */ template: `
  <div>
    @if (orderById.isLoading()) { <mat-progress-spinner mode="indeterminate" diameter="32"/> }
    @if (!orderById.isLoading() && !orderById.isError() && !orderById.data()) {
      <div class="loom-empty">Order not found</div>
    }
    @if (orderById.data()) { <!-- unknown layout component: OrderActions --> }
  </div>
`})
export class OrderConsoleComponent {
  private readonly route = inject(ActivatedRoute);
  readonly id = this.route.snapshot.paramMap.get("id") ?? "";
  readonly orderById = useOrderById(this.id);
}
```
::: end

## `area` & `menu`

`area Name { … }` groups pages into a named functional division: a contained page's file lands under `src/pages/<area-path>/<page>`, the path joining down the nesting. The `scaffold` macro names each aggregate's pages by **role** (`List`/`New`/`Detail`) inside a per-aggregate `area`, so a bare `link List` is ambiguous — disambiguate with the area-qualified `link Orders.List`.

A `ui`-level `menu { … }` block declares the sidebar explicitly; without one, the sidebar is **derived** from each page's `menu { section, label }` metadata (aggregates → "Aggregates", etc.). External links use the arrow form.

```ddd
menu {
  section "Sales" { link Orders.List, link OrderConsole }
  section "External" { link "Docs" -> "https://docs.acme.com" }
}
```

The derived sidebar emits as the app shell's navigation. With no explicit `menu`, the scaffolded `Order` pages group under "Aggregates":

::: tabs frontend
== react
```tsx
// src/App.tsx — derived sidebar + route table
<Stack gap={4} data-testid="nav-sidebar">
  <Divider my="xs" label="Aggregates" labelPosition="left" />
  <NavLink component={RouterLink} to="/orders" label="Orders" active={isActive("/orders")} data-testid="nav-orders" />
</Stack>
// …
<Routes>
  <Route element={<AppShellLayout />}>
    <Route path="/" element={<Home />} />
    <Route path="/orders" element={<OrderList />} />
    <Route path="/orders/new" element={<OrderNew />} />
    <Route path="/orders/:id" element={<OrderDetail />} />
    <Route path="/console/:id" element={<OrderConsole />} />
  </Route>
</Routes>
```
::: end

A `layout Name { main; <slot> { … } }` block defines named layout slots (`main` is the reserved `Outlet`/router-outlet position); pages opt in via the `layout:` page prop. Layouts and the `header`/`footer` app-shell beyond the menu are a minimal v0 surface — see [`../page-metamodel.md`](../page-metamodel.md) §14.

## `with scaffold(...)`

`ui WebApp with scaffold(aggregates: [Order]) { … }` is the one built-in macro: compile-time sugar that synthesises full pages from the domain. It's hierarchical — `subdomains:` → contexts → `{ aggregates:, workflows: }`. Per aggregate it emits three pages with **walker-stdlib bodies identical to hand-written ones** (`unfold` on a scaffolded page ejects real `.ddd`):

| Page | Body |
|---|---|
| `<Agg>List` | Breadcrumbs · Toolbar (heading + "New") · `QueryView { of: api.<Agg>.all }` → `Table`, one `Column` per non-collection scalar field. |
| `<Agg>New` | Breadcrumbs · heading · `Card { CreateForm { of: <Agg> } }` — one input per writable field, client-side validation. |
| `<Agg>Detail` | Breadcrumbs · heading · `QueryView { of: api.<Agg>.byId(id), single: true }` → field rows + one operation control per `public operation` + a related-entity list per `contains`. |

So `scaffold(aggregates: [Order])` alone produces `OrderList`, `OrderNew`, `OrderDetail` — the same output as writing each `page` by hand. The List page (React, Mantine pack):

```tsx
// src/pages/orders/list.tsx (excerpt) — synthesised by the scaffold macro
export default function OrderList() {
  const navigate = useNavigate();
  const orderAll = useAllOrders();
  return (
    <Stack data-testid="orders-list">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Orders</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>Orders</Title>
        <Button onClick={() => navigate("/orders/new")} data-testid="orders-list-create">New order</Button>
      </Group>
      {/* QueryView arms: Skeleton / Alert / Empty / Table … */}
      { orderAll.data && orderAll.data.length > 0 && (
        <Table striped highlightOnHover stickyHeader>
          <Table.Thead><Table.Tr>
            <Table.Th>ID</Table.Th><Table.Th>Customer Id</Table.Th><Table.Th>Status</Table.Th>
          </Table.Tr></Table.Thead>
          <Table.Tbody>
            { orderAll.data.map((row) => (
              <Table.Tr key={row.id} data-testid={"orders-row-" + row.id}>
                <Table.Td><RouterLink to={`/orders/${row.id}`}><IdValue id={row.id} /></RouterLink></Table.Td>
                <Table.Td><Text>{row.customerId}</Text></Table.Td>
                <Table.Td><Text>{row.status}</Text></Table.Td>
              </Table.Tr>
            )) }
          </Table.Tbody>
        </Table>
      ) }
    </Stack>
  );
}
```

The same scaffold lowers across every frontend — Vue (`<v-table>`/Vuetify), Svelte (`{#each}` over `loom-table`), Angular (`@for (… ; track …)` over `loom-table`):

::: tabs frontend
== angular
```ts
// src/app/pages/order-list.component.ts (excerpt) — same scaffold, Angular idiom
template: `
  <div class="loom-stack" data-testid="orders-list">
    <nav class="loom-breadcrumbs"><a [routerLink]='"/"'>Home</a><div>Orders</div></nav>
    <div class="loom-toolbar">
      <h2>Orders</h2>
      <button mat-button (click)='router.navigateByUrl("/orders/new")' data-testid="orders-list-create">New order</button>
    </div>
    @if ((orderAll.data() ?? []).length > 0) {
      <table class="loom-table loom-table-striped">
        <thead><tr><th>ID</th><th>Customer Id</th><th>Status</th></tr></thead>
        <tbody>
          @for (row of (orderAll.data() ?? []); track row.id) {
            <tr [attr.data-testid]='("orders-row-" + row.id)'>
              <td><a [routerLink]='"/orders/" + row.id'>{{ shortId(row.id) }}</a></td>
              <td>{{ row.customerId }}</td><td>{{ row.status }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  </div>`,
```
::: end

**Override by name:** declare an explicit `page <Name>` matching a scaffolded page's name and it replaces exactly that one — the three layered scales (whole context / whole aggregate / single page) are the same mechanism. Stacked `scaffold` directives may not double-scaffold the same construct, and may not produce two pages with the same generated name. The macro stdlib (`scaffold` / `scaffoldContext` / `scaffoldAggregate` / `scaffoldWorkflow`) is documented in [`../scaffold-macros.md`](../scaffold-macros.md).
