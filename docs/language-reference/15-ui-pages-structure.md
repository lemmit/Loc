# 15. UI: pages & structure

The frontend surface: a `ui` block bound to a frontend deployable, holding `page`s (route + body), `component`s (reusable region trees), `store`s (shared client state with a lifetime), reactive `state` / `derived` / `action` members, live-event handlers, an optional explicit `menu`, page-grouping `area`s, and the `with scaffold(...)` macro that synthesises CRUD pages from the domain. Reach for this chapter to learn exactly what a page or component emits — and where the frontends diverge.

> **Grammar:** `Ui`, `UiMember`, `UiApiParam`, `UiChannelParam`, `UiNotification`, `UiFunction`, `Page`, `PageProp`, `PageMenuMeta`, `Component`, `ComponentDecl`, `Store`, `StoreDecl`, `StateBlock`, `StateField`, `DerivedProp`, `ActionDecl`, `Area`, `MenuBlock`, `MenuSection`, `MenuLink`, `Layout`, `LayoutSlot` · **Validators:** `loom.react-deployable-missing-ui` (+ `vue`/`svelte`/`angular`/`feliz`/`flutter` siblings) · `loom.ui-framework-unhostable` · `loom.ui-binding-unmountable-platform` · `loom.ui-page-path-collision` · `loom.ui-page-slot-collision` · `loom.unresolved-page-ref` · `loom.component-missing-body` · `loom.slot-out-of-position` · `loom.slot-outside-component` · `loom.component-prop-type` · `loom.user-component-deferred-target` · `loom.ui-duplicate-area` · `loom.store-lifetime-invalid` · `loom.store-url-field-invalid` · `loom.store-state-inline-write` · `loom.missing-effect-marker` · `loom.effect-in-lambda` · `loom.instance-effect-needs-route-id` · `loom.op-form-needs-route-id` · **Docs:** [`../page-metamodel.md`](../page-metamodel.md), [`../actions.md`](../actions.md), [`../scaffold-macros.md`](../scaffold-macros.md)

The page metamodel is **framework-neutral**: one `ui { … }` source lowers onto **six** frontends — React (`react`), Vue 3 (`vue`), SvelteKit (`svelte`), Angular (`angular`), Feliz F#/Fable/Elmish (`feliz`) and Flutter/Dart+Riverpod (`flutter`) — plus the server-rendered `phoenixLiveView` framework hosted by a `platform: elixir` deployable. You switch target by the bound deployable's `platform:` (or the ui's `framework:`). Every `frontend` tab below is **real generated output** from the same `.ddd` — only the host framework's idiom differs.

## `ui` block & deployable binding

A `ui` is a `SystemMember` (peer to `subdomain`, `deployable`, `theme`, `layout`). A frontend deployable mounts it via `ui: <Name>`; the binding passes per-api handles (`ui: WebApp { Sales: api }`). `loom.ui-binding-unmountable-platform` rejects a `ui:`/`hosts:` binding on a platform that mounts no UI.

`UiMember`s are: `api <name>: <Contract>` (a local handle on a system `api` that page data bindings resolve against — `Sales.Order.byId(id)`), `channel <name>: <Context>.<Channel>` + `on <name>.<Event>(e) { … }` (live events, below), `function <n>(…): T extern from "…"` (a typed pure helper implemented by a hand-written module — see [21. Externs](21-externs.md)), plus `page`, `component`, `store`, `area` and `menu`.

Every frontend deployable **must** name a ui — its absence is a hard error (`loom.react-deployable-missing-ui` and the `vue`/`svelte`/`angular`/`feliz`/`flutter` siblings); a frontend deployable without a ui is a host with no mount point. The deployable side of the binding (`platform:`, `targets:`, `auth:`, `design:`) belongs to [2. Systems & topology](02-systems-and-topology.md), which also owns the system-level `theme { … }` block.

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
    page Home { route: "/" title: "Action showcase" body: Heading { "Action showcase", level: 1 } }
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
    platform: react       // ← swap for vue | svelte | angular | feliz | flutter
    targets: api
    ui: WebApp { Sales: api }
    port: 3001
  }
}
```

The `framework:` key on the ui block sets its framework independently of the host (`ui Ops { framework: vue }` on a `platform: react` host) — the four static-bundle frameworks (react/vue/svelte/angular) all run on any static-bundle host, and a `platform: elixir` deployable hosts `phoenixLiveView` *plus* all four static bundles under `/app`. `feliz` and `flutter` host only themselves (their builds are `dotnet fable`+vite and the Flutter SDK, not the shared vite pipeline). `loom.ui-framework-unhostable` rejects a host/ui contradiction.

## `page` — route, title, body

A page is a route + optional typed parameters + a single-expression `body:`. The body is one walker expression — a layout primitive, a component invocation, a `QueryView`, or a `match`.

```ddd
page Home {
  route: "/"
  title: "Action showcase"
  body: Heading { "Action showcase", level: 1 }
}
```

The page file lands at the framework's idiomatic route location, default-exported as the route component; `title:` lowers to a document-title effect.

::: tabs frontend
== react
```tsx
// src/pages/home.tsx
import { useEffect } from "react";
import { t } from "../i18n";
import { Title } from "@mantine/core";

export default function Home() {
  useEffect(() => { document.title = "Action showcase"; }, []);
  return (
    <Title order={1}>{t("page.Home.heading.s74b08", "Action showcase")}</Title>
  );
}
```
== svelte
```svelte
<!-- src/routes/(app)/+page.svelte -->
<h1 class="text-3xl font-bold tracking-tight">{t("page.Home.heading.s74b08", "Action showcase")}</h1>
```
::: end

(User-visible strings route through the `t()` catalog — see the i18n layer in [`../new-plan/T1-ui-frontend.md`](../new-plan/T1-ui-frontend.md) § M-T1.11.)

Other `PageProp`s: `title:` (an expression, so it may interpolate), `requires <expr>` (auth gate — renders a client-side `<Forbidden/>` guard on `auth: ui` frontends; see [`../auth.md`](../auth.md)), `state { … }` / `derived` / `action` (below), `menu { … }` (per-page sidebar metadata — keys `section`, `label`, `order`, `hidden`), `layout: <Name|default|none>`, and the SEO props `description:` / `ogImage:` / `canonical:` (plain string literals, projected into `index.html`).

**Route parameters.** `route:` takes a `STRING`; declared parameters (`page OrderConsole(customerId: string)`) type the framework's route-param hook, and every declared name the body references is destructured from it. `id` is magic: a `/…/:id` route binds `id` (and instance-op effects and `OperationForm` resolve against it) even when the page declares no parameter list.

>  **Honest gap — a page whose `body:` is a bare `match` is dropped.** `match { cond => … else => … }` is a normal expression (chapter 5) and parses fine as a page body, but the page then emits **no file and no route**, with zero diagnostics — verified on this HEAD. Wrap it in a layout primitive (`body: Stack { match { … } }`) until the walker's page-shell handles a top-level `match`.

Two pages that resolve to the same emit path are rejected by `loom.ui-page-path-collision` (a page's identity is its area path plus its name), and two pages claiming the same scaffold archetype slot by `loom.ui-page-slot-collision` — only one of them would be reachable from the router. A name in a rendered slot that resolves to no route param, `state` field, `derived` binding, lambda parameter or store field raises `loom.unresolved-page-ref` (the walker would otherwise emit a comment and silently drop the content).

## `component` — reusable region tree

A `component` is a typed function from parameters (and optional local `state` / `derived` / `action` declarations) to a `body:` expression. It never declares a route. Parameters may be primitives, **aggregate instances** (`order: Order` — `order.confirm` resolves to the operation and the walker hoists the matching mutation hook), `slot` markers (caller-supplied children, walked in the *caller's* scope) or `action` / `action(T)` markers (caller-supplied behaviour). Components live `ui`-scoped or top-level (a `.ddd` can be a pure component library).

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
== angular
```ts
// src/app/components/OrderActions.ts — a real standalone component with @Input()s
@Component({
  selector: "app-order-actions",
  imports: [MatButtonModule],
  template: `
      <div class="loom-toolbar" role="toolbar" aria-label="Actions">
        <button mat-button (click)='onConfirmOrder()' [disabled]='confirmOrder.isPending()'>Confirm</button>
        <button mat-button (click)='onCancelOrder()' [disabled]='cancelOrder.isPending()'>Cancel</button>
      </div>`,
})
export class OrderActions {
  @Input() order!: OrderResponse;
  readonly router = inject(Router);
  readonly confirmOrder = useConfirmOrder();
  async onConfirmOrder(): Promise<void> {
    const id = this.order?.id;
    if (!id) return;
    await this.confirmOrder.mutateAsync({ id, input: {} });
    this.router.navigateByUrl("/");
  }
  // …
}
```
::: end

A `Slot {}` in the body renders the children the caller passed; the caller supplies them positionally (`Panel { "Basket", Stack { … } }`). `Slot {}` outside a component is rejected by `loom.slot-outside-component` (a page has no caller), and the `slot` / `action` param markers are valid only on a component parameter list (`loom.slot-out-of-position`, `loom.action-out-of-position`). A call site whose argument doesn't match the declared param type raises `loom.component-prop-type`.

```ddd
component Panel(title: string) {
  body: Card { title, Slot {} }
}
```

```tsx
// src/components/Panel.tsx — `slot` children land as ReactNode
export interface PanelProps { title: string; children?: ReactNode }
export default function Panel({ title, children }: PanelProps) {
  return (
    <Card withBorder padding="md">
      <Title order={3}>{title}</Title>
      {children}
    </Card>
  );
}
```

A component with no `body:` (and no `extern from "…"`) is rejected by `loom.component-missing-body`; `extern from "path"` declares a hand-written component the generator references (emitting a `<Name>.props.ts` typed-props interface) but does not itself emit — declaring both is `loom.extern-component-has-body`.

> **Honest gaps — components that a target defers.** Angular and Feliz each **defer** component shapes their emitters can't render, and `loom.user-component-deferred-target` names the exact shape rather than letting the component vanish: on Angular, a body whose api read takes an `@Input()` as an argument (the hoisted read runs in the constructor, before Angular sets inputs); on Feliz, a body that needs a route id, reads a `store`, or issues a `<Agg>.byId(…)` read (whose fetch a *page* fires on route entry). Flutter drops a component carrying an async effect (`loom.flutter-async-effect-unsupported`), and Phoenix/HEEx rejects primitives inside a component that need the host page's LiveView process — assigns, uploads, `handle_event` clauses (`loom.heex-component-host-state-unsupported`).

## `state` / `derived` / `action`

A `state { … }` block declares reactive local fields (`name: Type = init`); `derived name: Type = Expr` is a computed read; writes use `:=`. Each lowers to the framework's native reactivity primitive — and that mapping **is** the cross-framework divergence.

```ddd
page Counter {
  route: "/counter"
  state { count: int = 0 }
  derived label: string = `Clicks: {count}`
  action bump() { count := count + 1 }
  body: Stack {
    Heading { label, level: 2 },
    Button { "Increment", onClick: bump }
  }
}
```

The write lives in a named `action`, referenced by name from the control. Writing it inline (`onClick: e => { count := count + 1 }`) is rejected by `loom.effect-in-lambda` — see [`../actions.md`](../actions.md) for the read-vs-write split that rule enforces.

::: tabs frontend
== react
```tsx
// useState + useMemo; the action hoists to a const, `:=` lowers to the setter
import { useState, useMemo } from "react";
export default function Counter() {
  const [count, setCount] = useState<number>(0);
  const label = useMemo(() => ("Clicks: " + String(count)), [count]);
  const bump = () => { setCount((count + 1)); };
  return (
    <Stack>
      <Title order={2}>{label}</Title>
      <Button onClick={bump}>{t("page.Counter.button.132vha", "Increment")}</Button>
    </Stack>
  );
}
```
== svelte
```svelte
<!-- Svelte 5 runes: $state + $derived; `:=` is an in-place assignment -->
<script lang="ts">
  let count = $state<number>(0);
  const label = $derived(("Clicks: " + String(count)));
  const bump = () => { count = (count + 1); };
</script>
<h2 class="text-2xl font-semibold tracking-tight">{label}</h2>
<button type="button" onclick={bump}>{t("page.Counter.button.132vha", "Increment")}</button>
```
::: end

`action name(params) { stmts }` names a handler so it can be referenced by identity instead of an inline lambda — positionally distinct from the `action(T)` param type and the `Action {}` render primitive (`loom.action-out-of-position` guards the slot). `+=` / `-=` are **type-driven**: arithmetic on a scalar target, append/remove on a collection target (`tags += newTag` → `[...tags, newTag]`). Nested writes (`draft.zip := v`) rebuild immutably on React, mutate in place on Vue/Svelte.

### Effect markers and `match await`

A remote mutating command called from an action carries an invisible async boundary, so it must be **marked**: `match await <api>.<Agg>.<op>(…) { … }`, discriminating the operation's result union.

```ddd
page OrderDetail {
  route: "/orders/:id"
  state { message: string = "" }
  action confirm() {
    match await Sales.Order.confirm() {
      Order o    => { message := o.code }
      Rejected r => { message := r.reason }
    }
  }
  body: Stack { Text { message }, Button { "Confirm", onClick: confirm } }
}
```

```tsx
// src/pages/order_detail.tsx — the marker lowers to await + a tagged-union switch
const orderConfirm = useConfirmOrder(id ?? "");
const confirm = async () => {
  let result: ConfirmOrderResponse;
  try {
    result = await orderConfirm.mutateAsync({});
  } catch (e) {
    if (e instanceof ApiError) {
      result = { ...(e.body as Record<string, unknown>), type: "Rejected" } as ConfirmOrderResponse;
    } else { throw e; }
  }
  switch (result.type) {
    case "Order":    { const o = result; setMessage(o.code); break; }
    case "Rejected": { const r = result; setMessage(r.reason); break; }
  }
};
```

The gates around this shape:

| Code | Rejects |
|---|---|
| `loom.missing-effect-marker` | a remote mutating command called with no `match await` |
| `loom.effect-in-lambda` | an effect (`#effect`) or remote mutation (`#remote-mutation`) inside a render-tree lambda |
| `loom.match-await-arg-mismatch` / `loom.match-await-arg-type` | awaited call whose arguments don't match the operation signature |
| `loom.instance-effect-needs-route-id` | an instance-op `match await` on a page whose route declares no `:id` |
| `loom.op-form-needs-route-id` | `OperationForm { of:, op: }` (no bound record) on a page whose route declares no `:id` |
| `loom.feliz-async-effect-unsupported` / `loom.flutter-async-effect-unsupported` | an async-effect shape those two frontends don't render |

## `store` — shared client state with a lifetime

A `store` is a `ui`-level container of `state` + named `action`s, reused verbatim from the page/component surface. There is **no** `use` clause: a page or component references it by dotted qualified name (`Cart.lines` reads, `Cart.clear()` calls), and the per-page store dependency is derived from the resolved refs at emit time. An optional `persist:` picks where the state lives — `memory` (default), `local`, `session` or `url`.

```ddd
store Cart persist: local {
  state { lines: string[] = []  count: int = 0 }
  action add(sku: string) { lines += sku  count += 1 }
  action clear() { lines := []  count := 0 }
}
```

::: tabs frontend
== react
```ts
// src/stores/cart.ts — zustand + the persist middleware for `persist: local`
export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      count: 0,
      add: (sku) => { set((s) => ({ lines: [...s.lines, sku] })); set((s) => ({ count: s.count + 1 })); },
      clear: () => { set(() => ({ lines: [] })); set(() => ({ count: 0 })); },
    }),
    { name: "loom.store.Cart", storage: createJSONStorage(() => localStorage) },
  ),
);
```
== flutter
```dart
// lib/stores.dart — a Riverpod Notifier; `persist:` hydrates in build()
class CartNotifier extends Notifier<CartState> {
  @override
  CartState build() {
    ref.listenSelf((_, next) => _persist(next));
    final blob = LoomStorePersist.read(_persistKey);
    return CartState(lines: _loadLines(blob), count: _loadCount(blob));
  }
  static const String _persistKey = 'loom.store.Cart';
  void add(String sku) {
    state = state.copyWith(lines: [...state.lines, sku]);
    state = state.copyWith(count: state.count + 1);
  }
  // …
}
```
::: end

A page consuming it subscribes per field, and a bare `onClick: Cart.clear` resolves to the store action:

```tsx
// src/pages/basket.tsx (excerpt)
const clear = useCart((s) => s.clear);
const lines = useCart((s) => s.lines);
```

The store gates:

| Code | Rejects |
|---|---|
| `loom.store-lifetime-invalid` | a `persist:` value outside `memory \| local \| session \| url` |
| `loom.store-url-field-invalid` | a non-scalar field in a `persist: url` store (only string/number/bool/enum/id round-trip through the query string) |
| `loom.store-state-inline-write` | a page/component action writing store state directly (`Cart.count := …`) — mutate through a store action |
| `loom.store-action-view-effect` | a view-scoped effect (`navigate`, …) inside a store action — a store has no router |
| `loom.store-action-cycle` | store actions that call each other cyclically |
| `loom.store-lifetime-liveview-invalid` | any `persist:` tier but `memory` on `phoenixLiveView` (a server-side per-process struct has no browser storage) |
| `loom.store-cross-store-on-liveview-invalid` | a LiveView store action calling a *different* store's action |
| `loom.store-lifetime-target-unsupported` | a persisted field whose type the Feliz (`#field`) or Flutter (`#flutter-field`) codec cannot round-trip |

## `QueryView` & page parameters

`QueryView { of:, loading:, error:, empty:, data:, single?: }` branches on the four async states of a repository find. A `data: o => …` lambda binds the loaded record; the `o` parameter resolves in the lambda's scope (so an aggregate-param component can consume it). A `/…/:id` route binds `id` for the read.

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
// src/app/pages/order-console.component.ts — user components mount via ngComponentOutlet
@Component({ imports: [MatProgressSpinnerModule, NgComponentOutlet], template: `
  <div>
    @if (orderById.isLoading()) { <mat-progress-spinner mode="indeterminate" diameter="32"></mat-progress-spinner> }
    @if (!orderById.isLoading() && !orderById.isError() && !orderById.data()) {
      <div class="loom-empty">{{ t("page.OrderConsole.empty.r9m7fu", "Order not found") }}</div>
    }
    @if (orderById.data()) {
      <ng-container [ngComponentOutlet]="OrderActions" [ngComponentOutletInputs]='{ order: orderById.data()! }'></ng-container>
    }
  </div>
`})
export class OrderConsoleComponent {
  protected readonly OrderActions = OrderActions;
  private readonly route = inject(ActivatedRoute);
  readonly id = this.route.snapshot.paramMap.get("id") ?? "";
  readonly orderById = useOrderById(this.id);
}
```
::: end

**Projection reads.** A page may read a `projection` ([10. Repositories & queries](10-repositories-and-queries.md) § `projection`) only when it is an **unkeyed query-time** projection — a whole-table singleton or a `group by` list. A keyed or folded projection has no frontend client, so reading one raises `loom.ui-projection-read-unsupported#not-ui-consumable`; hosting a projection-reading ui on a frontend that generates no projection client raises `#frontend-has-no-client`.

## Live events — `channel` + `on`

A ui subscribes to a context's `delivery: broadcast` channel and renders arriving events; the wire (SSE) is derived, never stated. A handler body supports `toast(<expr>)` and `refetch(<Aggregate>[, …])` — anything else is `loom.ui-handler-statement-unknown`, and an unknown refetch target is `loom.ui-handler-refetch-target`.

```ddd
ui WebApp {
  api Sales: SalesApi
  channel Live: Orders.Lifecycle
  on Live.OrderConfirmed(e) { toast(`Order {e.order} confirmed`) }
}
```

```svelte
<!-- src/lib/components/RealtimeHandlers.svelte — renderless, mounted once in the root layout -->
<script lang="ts">
  import { subscribeRealtime } from "$lib/api/realtime";
  import { toast } from "$lib/toast.svelte";
  $effect(() => {
    return subscribeRealtime((event) => {
      switch (event.type) {
        case "OrderConfirmed":
          toast.success("Order " + String(event.order ?? "") + " confirmed");
          break;
      }
    });
  });
</script>
```

Subscribing to a non-broadcast channel is `loom.ui-channel-not-broadcast`. Handlers that would be silently dropped are rejected rather than lost: `loom.ui-realtime-unsupported#backend-serves-no-sse` (the targeted backend serves no realtime wire) and `#frontend-has-no-consumer` (the frontend framework has no realtime consumption). The channel declaration itself is [14. APIs, storage, resources & channels](14-apis-storage-resources-channels.md) / [`../channels.md`](../channels.md).

## `area` & `menu`

`area Name { … }` groups pages into a named functional division: a contained page's file lands under `src/pages/<area-path>/<page>`, the path joining down the nesting (`area Ops { page Dashboard { … } }` → `src/pages/ops/dashboard.tsx`). Duplicate area names in one scope are rejected by `loom.ui-duplicate-area` — the area path *is* the on-disk identity, so two same-named blocks would overwrite each other. The `scaffold` macro names each aggregate's pages by **role** (`List`/`New`/`Detail`) inside a per-aggregate `area`, so a bare `link List` is ambiguous — disambiguate with the area-qualified `link Orders.List`.

A `ui`-level `menu { … }` block declares the sidebar explicitly; without one, the sidebar is **derived** from each page's `menu { section, label, order, hidden }` metadata (scaffolded aggregates group under "Aggregates"). External links use the arrow form; `link` props accept `label` and `order`.

```ddd
menu {
  section "Sales" { link Orders.List, link OrderConsole }
  section "Ops" { link Ops.Dashboard }
  section "External" { link "Docs" -> "https://docs.acme.com" }
}
```

```tsx
// src/App.tsx — sidebar + route table
<Stack gap={4} data-testid="nav-sidebar">
  <Divider my="xs" label={t("menu.section.czo7yv", "Sales")} labelPosition="left" />
  <NavLink component={RouterLink} to="/orders" label="Orders" active={isActive("/orders")} data-testid="nav-orders" />
  <Divider my="xs" label={t("menu.section.7egpx7", "Ops")} labelPosition="left" />
  <NavLink component={RouterLink} to="/ops" label="Dashboard" active={isActive("/ops")} data-testid="nav-ops_dashboard" />
  <Divider my="xs" label={t("menu.section.bjct62", "External")} labelPosition="left" />
  <Anchor href="https://docs.acme.com" target="_blank" rel="noreferrer" data-testid="nav-ext-docs">Docs</Anchor>
</Stack>
```

## `layout` — named app frames

A system-level `layout Name { … }` declares slots — `header`, `sidebar`, `footer` (each holding one page-body expression) plus exactly one bodyless `main`, which marks where the router's outlet lands. Pages opt in with `layout: <Name>`; the presets `default` (the app shell) and `none` are reserved names.

```ddd
layout AdminFrame {
  header { Heading { "Acme admin", level: 3 } }
  main
  footer { Text { "© Acme" } }
}
// …
page Reports { route: "/reports" layout: AdminFrame body: Text { "Inside the admin frame" } }
```

::: tabs frontend
== react
```tsx
// src/App.tsx — a layout route wraps the opted-in pages
function AdminFrameLayout() {
  return (
    <>
      <header><Title order={3}>Acme admin</Title></header>
      <main id="main-content"><AppErrorBoundary><Outlet /></AppErrorBoundary></main>
      <footer><Text>© Acme</Text></footer>
    </>
  );
}
// …
<Routes>
  <Route element={<AdminFrameLayout />}>
    <Route path="/reports" element={<Reports />} />
  </Route>
  <Route element={<AppShellLayout />}>
    <Route path="/" element={<Home />} />
    {/* … */}
  </Route>
</Routes>
```
== svelte
```
src/routes/(admin_frame)/+layout.svelte     ← the named layout becomes a route group
src/routes/(admin_frame)/reports/+page.svelte
src/routes/(app)/+layout.svelte             ← default app shell
src/routes/(app)/orders/[id]/+page.svelte
```
::: end

## `with scaffold(...)`

`ui WebApp with scaffold(aggregates: [Order]) { … }` is compile-time sugar that synthesises full pages from the domain. Its four parameters are reference lists — `subdomains:`, `contexts:`, `aggregates:`, `workflows:` — and the top-level macro just fans out to `scaffoldSubdomain` / `scaffoldContext` / `scaffoldAggregate` / `scaffoldWorkflow` (so `unfold` drills in one level at a time). An unknown or mistyped argument is a `loom.macro-arg-*` error. Per aggregate it emits three pages with **walker-stdlib bodies identical to hand-written ones** (`unfold` on a scaffolded page ejects real `.ddd`):

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

The same scaffold lowers across every frontend — Vue (`<v-table>`/Vuetify), Svelte (`{#each}` over `loom-table`), Angular (`@for (… ; track …)` over `loom-table`), plus Feliz and Flutter:

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

Pairing the ui-side `scaffold` with a context-side `scaffoldDashboard` grows the `Home` page a row of `Stat` tiles bound to that context's singleton dashboard projection (a row count plus a sum per numeric/money field, aggregated in SQL) — both halves derive the projection name from one place, so a tile can't bind a projection the other didn't emit.

**Override by name:** declare an explicit `page <Name>` matching a scaffolded page's name *in the same scope* and it replaces exactly that one — the three layered scales (whole context / whole aggregate / single page) are the same mechanism. Stacked `scaffold` directives may not double-scaffold the same construct, and may not produce two pages with the same generated name or archetype slot (`loom.ui-page-path-collision` / `loom.ui-page-slot-collision`). The macro stdlib (`scaffold` / `scaffoldContext` / `scaffoldAggregate` / `scaffoldWorkflow` / `scaffoldDashboard` / `scaffoldPaged` / …) is documented in [22. Macros](22-macros.md) and [`../scaffold-macros.md`](../scaffold-macros.md); the primitive library each body is built from is [16. UI: walker primitives](16-ui-walker-primitives.md).
