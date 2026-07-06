# 16. UI: the walker primitive library

Page bodies are written in a **closed primitive library** — `Stack`, `Heading`, `Field`, `Table`, plus the higher-level `Form`, `For`, `QueryView`, and `match`. There is no escape hatch to raw JSX; every primitive is dispatched by the body walker into the page's active **design pack**, so the same `.ddd` body renders as Mantine, shadcn, Vuetify, Material, or HEEx markup depending on the hosting frontend. Reach for this chapter to see exactly what each primitive emits and where the frameworks diverge.

> **Grammar:** primitives are `BuilderCall`s admitted by the registry `src/generator/_walker/registry.ts` (mirrored for the validator in `src/language/walker-stdlib.ts`) · **Validators:** `walker-stdlib-completeness.test.ts` pins the mirror; `loom.ui-handler-unsupported`, `loom.ui-framework-unhostable` · **Docs:** [`../page-metamodel.md`](../page-metamodel.md), [`../design-packs.md`](../design-packs.md)

The four `frontend` tabs (`react` / `vue` / `svelte` / `angular`) below are **real generated output** from one fixture: a single `ui Console` bound to a `react`, `vue`, `svelte`, and `angular` deployable. React's default pack is Mantine, Vue's Vuetify, Svelte's shadcnSvelte, Angular's Angular Material — so the divergence you see is *both* framework idiom (markup, control flow) *and* pack vocabulary (component names, classes). One extra `react` deployable pinned `design: shadcn` drives the `pack` tab where the design system changes the output.

## The dispatch model

A page `body:` is a single primitive call whose children are nested primitive calls. The walker (`walkBody`, `src/generator/_walker/walker-core.ts`) recurses the body `ExprIR`, and for each `call` looks the name up in `WALKER_PRIMITIVES` and invokes the active framework target's renderer. Five frameworks consume the shared walker core (React/Vue/Svelte/Angular via `WalkerTarget`); Phoenix LiveView runs a parallel HEEx engine because its output topology (hoisted `handle_event` clauses, comprehensions) diverges too far to share.

- **Layout / display / formatter / input** primitives render mostly the same *tree*; only the host markup and pack component names differ.
- **`match`, `For`, `QueryView`, ternaries** are *control flow*. Here the frameworks genuinely diverge — React renders a markup-valued ternary expression, while Vue/Svelte/Angular cannot put markup in an expression and instead emit block control flow (`<template v-if>`, `{#if}`, `@if`). That divergence is the meat of this chapter.

## Layout, display & formatter primitives

Containers (`Stack`, `Group`, `Grid`, `Container`, `Card`, `Toolbar`, `Paper`), display leaves (`Heading`, `Text`, `Badge`, `Stat`, `Divider`, `Avatar`, `KeyValueRow`), and formatters (`Money`, `DateDisplay`, `EnumBadge`, `IdLink`) all render as a single element wrapping their children. The first positional arg is the primary content (label / title / value); named args are picked off per primitive (`Heading`'s `level:`, `Money`'s `currency:`).

```ddd
page ProductDetail(id: Product id) {
  route: "/products/:id"
  state { editing: bool = false  draftName: string = "" }
  body: Container {
    Grid {
      Group { Avatar { "P" }, Heading { "Product detail", level: 2 } },
      Card { Stack {
        Field { "Name", bind: draftName },
        Toggle { "Editing", bind: editing },
        Stat { "Price", 1999 },
        Divider {},
        Money { 1999, currency: "USD" },
        KeyValueRow { "Owner", Text { "platform-team" } }
      } }
    },
    testid: "products-detail"
  }
}
```

`Stack`/`Group`/`Grid` become the pack's flex/grid container; `Field`/`Toggle` become controlled inputs bound to `state`; `Money` routes through the pack's currency-formatter helper.

The bindable inputs (`Field`, `NumberField`, `PasswordField`, `MultilineField`, `SelectField`, `Toggle`) also accept an optional **`error:`** expression, rendered in the pack's inline error slot. Since the expression is walked in page scope it can read `state`/`derived` — the idiom for dependent form validation over client-only fields (`error: passwordsMatch ? "" : "Passwords must match"`; see [page-metamodel.md §8.2](../page-metamodel.md)).

::: tabs frontend
== react
```tsx
// Mantine — pages/product_detail.tsx
<Container data-testid="products-detail">
  <Grid>
    <Grid.Col span="auto">
      <Group>
        <Avatar />
        <Title order={2}>Product detail</Title>
      </Group>
    </Grid.Col>
    <Grid.Col span="auto">
      <Card withBorder padding="md">
        <Stack>
          <TextInput label="Name" value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} />
          <Switch label="Editing" checked={editing} onChange={(e) => setEditing(e.currentTarget.checked)} />
          <Stack gap={2}>
            <Text size="sm" c="dimmed">Price</Text>
            <Text fw={700} size="xl">{1999}</Text>
          </Stack>
          <Divider />
          <MoneyValue value={ 1999 } currency="USD" />
          <KeyValueRow label="Owner"><Text>platform-team</Text></KeyValueRow>
        </Stack>
      </Card>
    </Grid.Col>
  </Grid>
</Container>
```
State is `const [draftName, setDraftName] = useState<string>("")`; the walker emits the setter for the `bind:`.
== vue
```vue
<!-- Vuetify — pages/product_detail.vue -->
<v-container data-testid="products-detail">
  <v-row>
    <v-col>
      <div class="d-flex align-center flex-wrap ga-3"><v-avatar></v-avatar><h2>Product detail</h2></div>
    </v-col>
    <v-col>
      <v-card variant="outlined" class="pa-4">
        <div class="d-flex flex-column ga-3">
          <v-text-field label="Name" :model-value="draftName" @update:model-value="setDraftName" />
          <v-switch label="Editing" :model-value="editing" @update:model-value="(v) => setEditing(!!v)" />
          <v-divider />
          <span>{{ formatMoney(1999, "USD") }}</span>
          <!-- Stat / KeyValueRow … -->
        </div>
      </v-card>
    </v-col>
  </v-row>
</v-container>
```
State is `const draftName = ref("")` with a generated `setDraftName` writer; reads in handlers unwrap `.value`.
== svelte
```svelte
<!-- shadcnSvelte — routes/(app)/products/[id]/+page.svelte -->
<div class="container ..." data-testid="products-detail">
  <div class="grid gap-4 grid-cols-3">
    <div class="flex flex-row items-center gap-4"><!-- Avatar --><h2 class="text-2xl font-semibold tracking-tight">Product detail</h2></div>
    <div class="rounded-xl border bg-card p-6">
      <label class="flex flex-col gap-2"><span class="loom-label">Name</span><input class="loom-input" value={draftName} oninput={(e) => { draftName = e.currentTarget.value; }} /></label>
      <label class="flex items-center gap-2"><input type="checkbox" role="switch" class="loom-switch" checked={editing} onchange={(e) => { editing = e.currentTarget.checked; }} /><span class="loom-label">Editing</span></label>
      <!-- Stat / Divider / Money / KeyValueRow … -->
    </div>
  </div>
</div>
```
State is a Svelte 5 rune: `let draftName = $state<string>("")`; the input writes the rune directly in its `oninput` handler.
== angular
```ts
// Angular Material — pages/product-detail.component.ts (template excerpt)
<div class="loom-stack" data-testid="products-detail">
  <div class="loom-grid">
    <div><div class="loom-group"><!-- Avatar --><h2>Product detail</h2></div></div>
    <div>
      <mat-card>
        <mat-form-field><mat-label>Name</mat-label><input matInput [value]="draftName()" (input)="draftName.set($any($event.target).value)" /></mat-form-field>
        <mat-slide-toggle [checked]="editing()" (change)="editing.set($event.checked)">Editing</mat-slide-toggle>
        <!-- Stat / Divider / Money / KeyValueRow … -->
      </mat-card>
    </div>
  </div>
</div>
```
State is an Angular signal: `readonly draftName = signal("")`; reads call `draftName()`, writes `draftName.set(...)`.
::: end

> **Pack vs. framework.** The four tabs above mix two axes. The next section isolates the *pack* axis — same framework (React), two design systems — so you can see the difference the `design:` pin alone makes.

## Design-pack divergence (`pack`)

The same React page, two packs. Mantine ships named components (`<TextInput>`, `<Switch label>`) from `@mantine/core`; shadcn ships `<Input>` + a separate `<Label>` from `@/components/ui/*` with Tailwind utility classes. The walker tree is identical — only the leaf rendering differs.

::: tabs pack
== mantine
```tsx
<Card withBorder padding="md">
  <Stack>
    <TextInput label="Name" value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} />
    <Switch label="Editing" checked={editing} onChange={(e) => setEditing(e.currentTarget.checked)} />
    <Divider />
  </Stack>
</Card>
// import { Card, Divider, Stack, Switch, TextInput } from "@mantine/core";
```
== shadcn
```tsx
<Card>
  <CardContent><div className="flex flex-col gap-4">
    <div className="flex flex-col gap-2"><Label>Name</Label><Input value={draftName} onChange={(e) => setDraftName(e.currentTarget.value)} /></div>
    <div className="flex items-center gap-2"><Switch checked={editing} onCheckedChange={(v) => setEditing(v)} /><Label>Editing</Label></div>
    <hr className="border-border" />
  </div></CardContent>
</Card>
// import { Card, CardContent } from "@/components/ui/card";
// import { Input } from "@/components/ui/input"; import { Label } from "@/components/ui/label";
// import { Switch } from "@/components/ui/switch";
```
::: end

## `CreateForm` — the form family

`CreateForm { of: <Aggregate> }` introspects the aggregate's non-optional fields and emits one input per field, dispatched by type: `string` → text input, `enum` → select, `bool` → toggle, `decimal` → number input, `datetime` → datetime input. The shell wires the submit handler to the aggregate's `create` mutation, with validation, redirect-on-success, and per-field error mapping. Siblings `OperationForm { inst.op }`, `WorkflowForm { runs: <wf> }`, and `DestroyForm { of: <Agg> }` follow the same shape over an operation / workflow / delete.

```ddd
page ProductNew {
  route: "/products/new"
  body: Stack {
    Heading { "Create product", level: 2 },
    Card { CreateForm { of: Product, testid: "products-new" } }
  }
}
```

For `aggregate Product { name: string  visibility: Visibility  active: bool  price: decimal  createdAt: datetime }`, the form emits a text input, a `Visibility` select, an active toggle, a price number input, and a datetime input — plus a submit button bound to the create mutation:

::: tabs frontend
== react
```tsx
const create = useCreateProduct();
const { register, handleSubmit, setError, control, formState: { errors } } = useForm<CreateProductRequest>({
  resolver: zodResolver(CreateProductRequest),
  defaultValues: { name: "", visibility: "Private", active: false, price: 0, createdAt: "" },
});
// …
<form onSubmit={handleSubmit(async (vals) => {
  const out = await create.mutateAsync(vals);
  notifications.show({ color: "green", message: "Product created" });
  navigate(`/products/${out.id}`);
  // catch → applyServerErrors maps field-level failures back onto the form
})} data-testid="products-new">
  <Stack gap="md">
    <TextInput label="Name" {...register("name")} data-testid="products-new-input-name" error={errors.name?.message} />
    <Controller control={control} name="visibility" render={({ field, fieldState }) => (
      <Select label="Visibility" data={ ["Private","Internal","Public"] } value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
    )} />
    <Controller control={control} name="active" render={({ field }) => (
      <Switch label="Active" checked={!!field.value} onChange={(e) => field.onChange(e.currentTarget.checked)} />
    )} />
    <Controller control={control} name="price" render={({ field }) => (
      <NumberInput label="Price" decimalScale={2} fixedDecimalScale value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} />
    )} />
    <TextInput label="Created At" {...register("createdAt")} type="datetime-local" />
    <Group justify="flex-end" mt="sm">
      <Button type="submit" loading={ create.isPending } data-testid="products-new-submit">Create</Button>
    </Group>
  </Stack>
</form>
```
React Hook Form + zodResolver + a React Query mutation hook (`useCreateProduct`). Enum / bool / number bind through `<Controller>`; string / datetime through `register`.
== vue
```vue
<!-- Vuetify — a useLoomForm composable drives the same field set -->
const form = useLoomForm(CreateProductRequest, { name: "", visibility: "Private", active: false, price: 0, createdAt: "" });
// …
<v-form @submit.prevent='form.handleSubmit(async (vals) => { const out = await create.mutateAsync(vals); pushToast("Product created"); navigate(`/products/${out.id}`); })($event)'>
  <v-text-field label="Name" v-model="form.values.name" :error-messages='form.errors["name"]' />
  <v-select label="Visibility" :items='["Private","Internal","Public"]' v-model="form.values.visibility" />
  <v-switch label="Active" v-model="form.values.active" />
  <v-text-field label="Price" type="number" step="0.01" :model-value="form.values.price" @update:model-value="(v) => form.values.price = Number(v) || 0" />
  <v-text-field label="Created At" type="datetime-local" v-model="form.values.createdAt" />
  <v-btn type="submit" color="primary" variant="flat" :loading="create.isPending">Create</v-btn>
</v-form>
```
A `useLoomForm` composable + the same field dispatch (select / switch / number / datetime), bound with `v-model="form.values.*"` instead of `Controller`.
::: end

> Form details (field-type dispatch, `onSubmit:`/`then:` overrides, the `OperationForm`/`WorkflowForm`/`DestroyForm` siblings) are in [`../page-metamodel.md`](../page-metamodel.md) §9 and the loom-forms reference.

## `QueryView` — async data branching

`QueryView { of:, loading:, error:, empty:, data: rows => … }` is the central async-data primitive: it reads a query (`api.<Agg>.all`, a `find`, or a view), and renders one of four arms by query state. The `data:` arm is a lambda whose param binds the loaded rows. This is where the frameworks diverge sharply — React renders four short-circuit JSX expressions, while Vue/Svelte/Angular collapse it into native block control flow.

```ddd
QueryView {
  of: Shop.Product.all,
  loading: Skeleton { count: 5 },
  error: Alert { "Couldn't load products" },
  empty: Empty { "No products yet." },
  data: rows => Paper { Table {
    rows: rows, striped: true,
    Column { "ID", o => IdLink { o.id, of: Product } },
    Column { "Name", o => Text { o.name } },
    Column { "Visibility", o => EnumBadge { o.visibility } },
    Column { "Price", o => Money { o.price, currency: "USD" } },
    Column { "Created", o => DateDisplay { o.createdAt } }
  } }
}
```

The walker hoists the query to a hook/store at component top (`useAllProducts()`), then branches on its state. `Table` rows iterate the loaded data; each `Column`'s accessor lambda walks with its param bound to the row.

::: tabs frontend
== react
```tsx
const productAll = useAllProducts();
// …four short-circuit expressions, one per state:
<>
  { productAll.isLoading && (
    <Stack gap="xs">{ Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={ 28 } radius="sm" />) }</Stack>
  ) }
  { productAll.isError && (<Alert color="red" variant="light">Couldn't load products</Alert>) }
  { productAll.data && productAll.data.length === 0 && (
    <Center mih={200}><Text c="dimmed">No products yet.</Text></Center>
  ) }
  { productAll.data && productAll.data.length > 0 && (
    <Paper p="md"><Table striped>
      <Table.Thead><Table.Tr><Table.Th>ID</Table.Th>{/* … */}</Table.Tr></Table.Thead>
      <Table.Tbody>
        { productAll.data.map((row) => (
          <Table.Tr key={ row.id }>
            <Table.Td><RouterLink to={`/products/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
            <Table.Td><Text>{row.name}</Text></Table.Td>
            <Table.Td><Badge tt="none">{ row.visibility }</Badge></Table.Td>
            <Table.Td><MoneyValue value={ row.price } currency="USD" /></Table.Td>
            <Table.Td><DateTimeValue iso={ row.createdAt } /></Table.Td>
          </Table.Tr>
        )) }
      </Table.Tbody>
    </Table></Paper>
  ) }
</>
```
== vue
```vue
<div>
  <template v-if="productAll.isLoading">
    <div class="d-flex flex-column ga-2"><v-skeleton-loader v-for="__i in 5" :key="__i" type="text" height="28" /></div>
  </template>
  <template v-if="productAll.isError"><v-alert color="red" variant="tonal">Couldn't load products</v-alert></template>
  <template v-if="productAll.data && productAll.data.length === 0">
    <div class="d-flex align-center justify-center text-medium-emphasis" style="min-height: 200px">No products yet.</div>
  </template>
  <template v-if="productAll.data && productAll.data.length > 0">
    <v-card variant="outlined" class="pa-4"><v-table striped="even">
      <thead><tr><th>ID</th><!-- … --></tr></thead>
      <tbody>
        <tr v-for="(row) in productAll.data" :key="row.id">
          <td><router-link :to="`/products/${ row.id }`" :title="row.id">{{ shortId(row.id) }}</router-link></td>
          <td><div>{{ row.name }}</div></td>
          <td><v-chip size="small">{{ row.visibility }}</v-chip></td>
          <td><span>{{ formatMoney(row.price, "USD") }}</span></td>
          <td><span>{{ formatDateTime(row.createdAt) }}</span></td>
        </tr>
      </tbody>
    </v-table></v-card>
  </template>
</div>
```
Each arm is a sibling `<template v-if>`; rows iterate with `v-for :key`.
== svelte
```svelte
{#if productAll.isLoading}
    <div class="flex flex-col gap-2">{#each Array.from({ length: 5 }) as _unused, i (i)}<div class="h-7 animate-pulse rounded-sm bg-muted"></div>{/each}</div>
  {:else if productAll.isError}
    <div role="alert" class="...">Couldn't load products</div>
  {:else if (productAll.data ?? []).length === 0}
    <div class="flex min-h-[200px] items-center justify-center"><p class="text-sm text-muted-foreground">No products yet.</p></div>
  {:else}
    <div class="rounded-lg border bg-card p-4 shadow-sm"><table class="w-full caption-bottom text-sm">
      <thead><tr><th>ID</th><!-- … --></tr></thead>
      <tbody>
        {#each (productAll.data ?? []) as row (row.id)}
          <tr>
            <td><a href={`/products/${ row.id }`}><code title={ row.id }>{formatId(row.id)}</code></a></td>
            <td><p>{row.name}</p></td>
            <td><span>{ row.visibility }</span></td>
            <td><span>{formatMoney(row.price, "USD")}</span></td>
            <td><span title={ row.createdAt }>{formatDateTime(row.createdAt)}</span></td>
          </tr>
        {/each}
      </tbody>
    </table></div>
{/if}
```
Svelte collapses all four arms into one `{#if}/{:else if}/{:else}` chain — the `empty:` arm is a native `{:else if … .length === 0}`, no re-evaluation of the collection.
== angular
```ts
<div data-testid="products-query">
  @if (productAll.isLoading()) {
    <div class="loom-skeleton-group"><div class="loom-skeleton" style="height: 28px"></div><!-- ×5 --></div>
  }
  @if (productAll.isError()) {
    <div class="loom-alert loom-alert-red" role="alert"><div class="loom-alert-message">Couldn't load products</div></div>
  }
  @if (!productAll.isLoading() && !productAll.isError() && (productAll.data() ?? []).length === 0) {
    <div class="loom-empty">No products yet.</div>
  }
  @if ((productAll.data() ?? []).length > 0) {
    <div class="loom-paper"><table class="loom-table loom-table-striped">
      <thead><tr><th>ID</th><!-- … --></tr></thead>
      <tbody>
        @for (row of (productAll.data() ?? []); track row.id) {
          <tr><td><a [routerLink]='"/products/" + row.id'>{{ shortId(row.id) }}</a></td>
              <td><div>{{ row.name }}</div></td>
              <td><span class="loom-badge">{{ row.visibility }}</span></td>
              <td><span>{{ formatMoney(row.price, "USD") }}</span></td>
              <td><span>{{ formatDateTime(row.createdAt) }}</span></td></tr>
        }
      </tbody>
    </table></div>
  }
</div>
```
Angular uses `@if` blocks (signals invoked: `productAll.isLoading()`); rows iterate with `@for (… ; track …)`.
::: end

## `For` — list comprehension

`For { each: <coll>, <item> => <markup> }` emits the item lambda's markup once per element. It is a *child* primitive — nest it inside a layout container; it isn't a standalone page body. The optional `empty:` arm renders when the collection is empty.

```ddd
For {
  each: ["alpha", "beta"],
  tag => Badge { tag }
}
```

Each framework lowers to its native keyed iteration construct; the list key defaults to the loop index.

::: tabs frontend
== react
```tsx
{["alpha", "beta"].map((tag, tagIdx) => (
  <Fragment key={tagIdx}>
    <Badge>{/* ref: tag */}</Badge>
  </Fragment>
))}
```
`.map` with a keyed `<Fragment>` (no wrapper DOM node).
== vue
```vue
<template v-for='(tag, tagIdx) in ["alpha", "beta"]' :key="tagIdx">
  <v-chip size="small"><!-- ref: tag --></v-chip>
</template>
```
A non-rendering `<template v-for :key>`.
== svelte
```svelte
{#each ["alpha", "beta"] as tag, tagIdx (tagIdx)}
  <span class="...badge..."><!-- ref: tag --></span>
{/each}
```
Native keyed `{#each … (key)}`.
== angular
```ts
@for (tag of ["alpha", "beta"]; track $index) {
  <span class="loom-badge"><!-- ref: tag --></span>
}
```
`@for` with a mandatory `track`; the index alias is declared only when referenced.
::: end

> **Honest gap.** A bare item-param ref used as a primitive's *content* arg (`Badge { tag }`) currently emits `<!-- ref: tag -->` rather than interpolating the value — visible in all four tabs above. Member access on the item resolves correctly (a `Column`'s `o => Text { o.name }` renders `{row.name}` — see the `QueryView` table rows). For `For` items, render a field of the item (`o => Text { o.name }`) rather than the bare scalar until the gap closes. Phoenix LiveView lowers `For` to a `for … do … end` comprehension block.

## `match` in markup — the ternary/block split

`match { pred => value, … else => value }` is the predicate-arm conditional. In *body* position (markup-valued arms), it is where the React-vs-everyone-else split is sharpest: React renders a markup-valued ternary expression, the rest emit block control flow (template expressions in those frameworks can't evaluate to markup).

```ddd
match {
  showArchived == true => Badge { "showing archived" },
  else => Text { "active only" }
}
```

::: tabs frontend
== react
```tsx
{((showArchived === true)) ? (<Badge>showing archived</Badge>) : <Text>active only</Text>}
```
A nested ternary expression, brace-wrapped as a JSX child. Multiple arms chain as `a ? … : b ? … : else`.
== vue
```vue
<template v-if="(showArchived === true)">
  <v-chip size="small">showing archived</v-chip>
</template>
<template v-else>
  <div>active only</div>
</template>
```
`<template v-if>` / `v-else-if` / `v-else` siblings. (The predicate is attribute-quoted — a predicate mixing single and double quotes is rejected at codegen.)
== svelte
```svelte
{#if (showArchived === true)}
  <span class="...badge...">showing archived</span>
{:else}
  <p class="...">active only</p>
{/if}
```
A `{#if}/{:else if}/{:else}` block.
== angular
```ts
@if ((showArchived() === true)) {
  <span class="loom-badge">showing archived</span>
} @else {
  <div>active only</div>
}
```
An `@if/@else if/@else` control-flow chain (signal read: `showArchived()`).
::: end

> **Phoenix LiveView.** HEEx renders `match` as an `if`/`else` block (`heex-target.ts`), not a ternary — same shape as Svelte/Angular. More broadly, the Phoenix walker supports a **subset** of the registry: primitives without a `heex` renderer (and several inputs/formatters) fall through to a *visible HEEx comment* marking the divergence rather than emitting wrong markup, so a Phoenix-served page degrades loudly, not silently. `test/generator/elixir/heex-parity.test.ts` freezes the set of TSX-only primitives so a new one can't silently regress Phoenix.

## Where to go next

- The full primitive list (and which group each belongs to) is the registry: `src/generator/_walker/registry.ts`. The language-side admissibility mirror is `src/language/walker-stdlib.ts`, pinned by `walker-stdlib-completeness.test.ts`.
- Page structure, `state {}`, `component`, scaffolding, and the `match`/lambda surface: [`../page-metamodel.md`](../page-metamodel.md).
- Authoring a new design pack (manifest, stacks, required emits, per-primitive templates): [`../design-packs.md`](../design-packs.md).
- The framework-divergent seams each target implements (`renderMatchChild`, `renderForEach`, state read/write, navigation): `src/generator/_walker/target.ts` and the per-framework targets under `src/generator/{react,vue,svelte,angular}/walker/`.
